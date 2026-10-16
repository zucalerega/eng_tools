"""Turning Parasolid solids (parasolid.py) into triangles for Caliper, as SolidWorks would draw them, where a part saved
none of its own (docs/vault.md, "Caliper").

A solid is a boundary: faces, each on a surface (a plane, cylinder, cone, sphere, torus, B-spline, rolling ball blend,
swept or spun surface) and bounded by loops of edges on curves (lines, circles, ellipses, B-splines, intersections of
two surfaces, curves in a surface's parameters). Each edge is sampled once, finely enough that its chords stray from
the curve by no more than the tolerance, so the faces either side of it share its points. Each face's loops are then
taken into its surface's parameters (u, v) and the region they bound there is cut into strips, at every boundary
point's u and wherever the surface curves enough to need it, and each strip into cells between the boundaries that
cross it (and, on surfaces curved both ways, at steps of v): their corners on the boundary are on its chords, the
rest on the surface. Which side of a boundary the face is on is its loop's direction: the face is on its left, seen
from the side its normal points to.

Where the reference (parasolid.py) and the files disagree, the files win: a cone is P + vA + (X cos u + Y sin u)(r +
v tan a), not P - vA + ..., as the curves its edges keep in its parameters show; and a blend's natural normal points
away from its spine, as a cylinder's does from its axis. Read this way, the 435 parts of the team's vault that have
both a display list and a solid agree with SolidWorks' own triangles within a percent in area and volume (and to a
few microns in size), but for those whose display list shows something their solid hasn't (a cosmetic thread, another
configuration). A solid this can't follow is refused (XtError), never guessed at.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from .parasolid import Node, XtError

Vec = tuple[float, float, float]
UV = tuple[float, float]
Rgb = tuple[float, float, float]

TAU = 2 * math.pi
MAX_TRIANGLES = 3_000_000  # a part with more than this is more than Caliper shows
_MOST = math.radians(12)  # the widest angle a chord may span on a curved surface or edge


class Unfollowed(XtError):
    """A solid Caliper can't follow, and why."""


# --- vectors -----------------------------------------------------------------------------------------------------


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a: Vec) -> float:
    return math.sqrt(dot(a, a))


def unit(a: Vec) -> Vec:
    n = norm(a)
    return mul(a, 1 / n) if n > 0 else a


def lerp(a: Vec, b: Vec, f: float) -> Vec:
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)


def angle_step(radius: float, tol: float) -> float:
    """The widest angle around a circle of this radius whose chord strays from it by no more than tol."""
    if radius <= tol:
        return _MOST
    return min(_MOST, 2 * math.acos(max(-1.0, 1 - tol / radius)))


# --- B-splines ---------------------------------------------------------------------------------------------------


def _span(knots: list[float], degree: int, count: int, t: float) -> int:
    if t >= knots[count]:
        return count - 1
    if t <= knots[degree]:
        return degree
    lo, hi = degree, count
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if knots[mid] <= t:
            lo = mid
        else:
            hi = mid
    return lo


def _de_boor(points: list[tuple[float, ...]], knots: list[float], degree: int, t: float) -> list[float]:
    k = _span(knots, degree, len(points), t)
    d = [list(points[j + k - degree]) for j in range(degree + 1)]
    for r in range(1, degree + 1):
        for j in range(degree, r - 1, -1):
            i = j + k - degree
            den = knots[i + degree - r + 1] - knots[i]
            a = (t - knots[i]) / den if den else 0.0
            d[j] = [(1 - a) * x + a * y for x, y in zip(d[j - 1], d[j], strict=True)]
    return d[degree]


def _expanded(knots: list[float], mults: list[int]) -> list[float]:
    """A knot vector: each distinct knot as many times as its multiplicity says."""
    if len(knots) != len(mults) or any(m < 1 for m in mults):
        raise Unfollowed("A B-spline's knots don't match their multiplicities")
    return [k for k, m in zip(knots, mults, strict=True) for _ in range(m)]


class Spline:
    """A B-spline curve in any dimension. Rational ones keep their weights as their points' last coordinate, the
    others multiplied through by it (as Parasolid stores them)."""

    def __init__(self, degree: int, vertices: list[float], dim: int, knots: list[float], mults: list[int],
                 rational: bool, periodic: bool) -> None:  # fmt: skip
        if degree < 1 or dim < 2 or len(vertices) % dim:
            raise Unfollowed("A B-spline has a degree or points that don't fit")
        self.degree, self.rational, self.periodic = degree, rational, periodic
        self.points = [tuple(vertices[i : i + dim]) for i in range(0, len(vertices), dim)]
        self.knots = _expanded(knots, mults)
        if len(self.knots) != len(self.points) + degree + 1:
            raise Unfollowed("A B-spline's knots don't add up")
        self.t0, self.t1 = self.knots[degree], self.knots[len(self.points)]
        self.spans = len(set(self.knots)) - 1

    def at(self, t: float) -> tuple[float, ...]:
        if self.periodic and self.t1 > self.t0:
            t = self.t0 + (t - self.t0) % (self.t1 - self.t0)
        h = _de_boor(self.points, self.knots, self.degree, t)
        if self.rational:
            return tuple(x / h[-1] for x in h[:-1])
        return tuple(h)


class SplineSurface:
    """A tensor-product B-spline surface: rows of points along v, one for each point along u (as Parasolid stores
    them: v varies fastest, which the curves in its parameters on these surfaces confirm)."""

    def __init__(self, f: dict[str, Any], vertices: list[float], u_knots: list[float], v_knots: list[float],
                 u_mults: list[int], v_mults: list[int]) -> None:  # fmt: skip
        self.pu, self.pv = f["u_degree"], f["v_degree"]
        nu, nv, dim = f["n_u_vertices"], f["n_v_vertices"], f["vertex_dim"]
        if self.pu < 1 or self.pv < 1 or dim < 3 or len(vertices) != nu * nv * dim:
            raise Unfollowed("A B-surface's points don't fit its size")
        self.rational = bool(f["rational"])
        self.rows = [
            [tuple(vertices[(i * nv + j) * dim : (i * nv + j + 1) * dim]) for j in range(nv)] for i in range(nu)
        ]
        self.uk, self.vk = _expanded(u_knots, u_mults), _expanded(v_knots, v_mults)
        if len(self.uk) != nu + self.pu + 1 or len(self.vk) != nv + self.pv + 1:
            raise Unfollowed("A B-surface's knots don't add up")
        self.u_periodic, self.v_periodic = bool(f["u_periodic"]), bool(f["v_periodic"])
        self.u0, self.u1 = self.uk[self.pu], self.uk[nu]
        self.v0, self.v1 = self.vk[self.pv], self.vk[nv]
        self.u_spans, self.v_spans = len(set(self.uk)) - 1, len(set(self.vk)) - 1

    def at(self, u: float, v: float) -> Vec:
        if self.u_periodic and self.u1 > self.u0:
            u = self.u0 + (u - self.u0) % (self.u1 - self.u0)
        if self.v_periodic and self.v1 > self.v0:
            v = self.v0 + (v - self.v0) % (self.v1 - self.v0)
        # Only the rows u's knot span weighs need evaluating along v (the rest would be multiplied by 0).
        k = _span(self.uk, self.pu, len(self.rows), u)
        column: list[tuple[float, ...]] = [()] * len(self.rows)
        for i in range(k - self.pu, k + 1):
            column[i] = tuple(_de_boor(self.rows[i], self.vk, self.pv, v))
        h = _de_boor(column, self.uk, self.pu, u)
        if self.rational:
            return (h[0] / h[3], h[1] / h[3], h[2] / h[3])
        return (h[0], h[1], h[2])


# --- surfaces ----------------------------------------------------------------------------------------------------


class Surface:
    sense = "+"
    flip = False  # whether its natural normal (Parasolid's) is against du x dv here
    u_period: float | None = None
    v_period: float | None = None
    v_min: float | None = None  # a bound of v a face may reach without an edge: a pole, a cone's apex
    v_max: float | None = None
    follows = False  # whether finding a point's (u, v) is best started from the last point's

    def at(self, u: float, v: float) -> Vec:
        raise NotImplementedError

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        raise NotImplementedError

    def singular(self, p: Vec) -> float | None:
        """The v of a pole or apex at p, where u is anything."""
        return None

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        """How far apart in u and in v points may be, where it curves (None: it doesn't that way)."""
        return None, None

    def normal(self, u: float, v: float) -> Vec:
        h = 1e-6
        q = self.at(u, v)
        return unit(cross(sub(self.at(u + h, v), q), sub(self.at(u, v + h), q)))

    def project(self, p: Vec, near: UV | None = None) -> tuple[Vec, Vec, UV]:
        """A point of the surface near p, its normal there, and its (u, v)."""
        u, v = self.uv(p, near)
        return self.at(u, v), self.normal(u, v), (u, v)

    def nearest(self, p: Vec) -> Vec:
        """The surface's point nearest p (where a rolling ball touches it)."""
        return self.at(*self.uv(p))


class Plane(Surface):
    def __init__(self, f: dict[str, Any]) -> None:
        self.p, self.n, self.x = f["pvec"], unit(f["normal"]), unit(f["x_axis"])
        self.y = cross(self.n, self.x)

    def at(self, u: float, v: float) -> Vec:
        return add(self.p, add(mul(self.x, u), mul(self.y, v)))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        w = sub(p, self.p)
        return (dot(w, self.x), dot(w, self.y))

    def nearest(self, p: Vec) -> Vec:
        return sub(p, mul(self.n, dot(sub(p, self.p), self.n)))


class _Round(Surface):
    """A surface round an axis: u the angle from x, Y = A x X."""

    u_period = TAU

    def __init__(self, centre: Vec, axis: Vec, x: Vec) -> None:
        self.c, self.a, self.x = centre, unit(axis), unit(x)
        self.y = cross(self.a, self.x)

    def around(self, u: float) -> Vec:
        return add(mul(self.x, math.cos(u)), mul(self.y, math.sin(u)))

    def angle(self, w: Vec) -> float:
        return math.atan2(dot(w, self.y), dot(w, self.x))


class Cylinder(_Round):
    def __init__(self, f: dict[str, Any]) -> None:
        super().__init__(f["pvec"], f["axis"], f["x_axis"])
        self.r = f["radius"]

    def at(self, u: float, v: float) -> Vec:
        return add(self.c, add(mul(self.around(u), self.r), mul(self.a, v)))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        w = sub(p, self.c)
        return (self.angle(w), dot(w, self.a))

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return angle_step(self.r, tol), None

    def nearest(self, p: Vec) -> Vec:
        w = sub(p, self.c)
        axial = mul(self.a, dot(w, self.a))
        return add(self.c, add(axial, mul(unit(sub(w, axial)), self.r)))


class Cone(_Round):
    """P + vA + (X cos u + Y sin u)(r + v tan a). The reference writes -vA; the curves cones' edges keep in their
    parameters end where their own points are only this way (and du x dv then points away from the axis, as the
    natural normal does)."""

    def __init__(self, f: dict[str, Any]) -> None:
        super().__init__(f["pvec"], f["axis"], f["x_axis"])
        self.r = f["radius"]
        if not f["cos_half_angle"]:
            raise Unfollowed("A cone is flat")
        self.tan = f["sin_half_angle"] / f["cos_half_angle"]
        self.apex = -self.r / self.tan if self.tan else None
        if self.tan > 0:
            self.v_min = self.apex
        elif self.tan < 0:
            self.v_max = self.apex

    def radius(self, v: float) -> float:
        return self.r + v * self.tan

    def at(self, u: float, v: float) -> Vec:
        return add(add(self.c, mul(self.a, v)), mul(self.around(u), self.radius(v)))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        w = sub(p, self.c)
        return (self.angle(w), dot(w, self.a))

    def singular(self, p: Vec) -> float | None:
        if self.apex is not None and norm(sub(p, add(self.c, mul(self.a, self.apex)))) < 1e-9:
            return self.apex
        return None

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        widest = max((abs(self.radius(v)) for _, v in uvs), default=abs(self.r))
        return angle_step(widest, tol), None

    def nearest(self, p: Vec) -> Vec:
        # In the half-plane through the axis and p: the foot of p on the line the cone sweeps.
        w = sub(p, self.c)
        z = dot(w, self.a)
        radial = sub(w, mul(self.a, z))
        e = unit(radial) if norm(radial) > 1e-15 else self.x
        v = (z + (norm(radial) - self.r) * self.tan) / (1 + self.tan * self.tan)
        if self.v_min is not None:
            v = max(v, self.v_min)
        if self.v_max is not None:
            v = min(v, self.v_max)
        return add(add(self.c, mul(self.a, v)), mul(e, self.radius(v)))


class Sphere(_Round):
    v_min, v_max = -math.pi / 2, math.pi / 2

    def __init__(self, f: dict[str, Any]) -> None:
        super().__init__(f["centre"], f["axis"], f["x_axis"])
        self.r = f["radius"]

    def at(self, u: float, v: float) -> Vec:
        return add(self.c, add(mul(self.around(u), self.r * math.cos(v)), mul(self.a, self.r * math.sin(v))))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        w = sub(p, self.c)
        x, y, z = dot(w, self.x), dot(w, self.y), dot(w, self.a)
        return (math.atan2(y, x), math.atan2(z, math.hypot(x, y)))

    def singular(self, p: Vec) -> float | None:
        w = sub(p, self.c)
        if math.hypot(dot(w, self.x), dot(w, self.y)) < 1e-9:
            return math.copysign(math.pi / 2, dot(w, self.a))
        return None

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        step = angle_step(self.r, tol)
        return step, step

    def nearest(self, p: Vec) -> Vec:
        return add(self.c, mul(unit(sub(p, self.c)), self.r))


class Torus(_Round):
    v_period = TAU

    def __init__(self, f: dict[str, Any]) -> None:
        super().__init__(f["centre"], f["axis"], f["x_axis"])
        self.major, self.minor = f["major_radius"], f["minor_radius"]

    def at(self, u: float, v: float) -> Vec:
        ring = mul(self.around(u), self.major + self.minor * math.cos(v))
        return add(self.c, add(ring, mul(self.a, self.minor * math.sin(v))))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        w = sub(p, self.c)
        x, y, z = dot(w, self.x), dot(w, self.y), dot(w, self.a)
        return (math.atan2(y, x), math.atan2(z, math.hypot(x, y) - self.major))

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return angle_step(abs(self.major) + self.minor, tol), angle_step(self.minor, tol)

    def nearest(self, p: Vec) -> Vec:
        w = sub(p, self.c)
        ring = add(self.c, mul(unit(sub(w, mul(self.a, dot(w, self.a)))), self.major))
        return add(ring, mul(unit(sub(p, ring)), self.minor))


def newton_uv(surface: Surface, p: Vec, u: float, v: float, bounds: SplineSurface | None = None) -> UV:
    """The (u, v) of p's nearest point on a surface, from (u, v): Gauss-Newton, each step halved until it brings the
    point closer, so it finds the solution nearest its start (a thread's surface passes some points more than once);
    kept within a B-surface's range, where off it is only its extrapolation."""

    def clamp(u: float, v: float) -> UV:
        if bounds is not None:
            if not bounds.u_periodic:
                u = min(max(u, bounds.u0), bounds.u1)
            if not bounds.v_periodic:
                v = min(max(v, bounds.v0), bounds.v1)
        return u, v

    h = 1e-7
    u, v = clamp(u, v)
    q = surface.at(u, v)
    err = norm(sub(p, q))
    for _ in range(40):
        if err < 1e-12:
            break
        du = mul(sub(surface.at(u + h, v), q), 1 / h)
        dv = mul(sub(surface.at(u, v + h), q), 1 / h)
        r = sub(p, q)
        a11, a12, a22 = dot(du, du), dot(du, dv), dot(dv, dv)
        det = a11 * a22 - a12 * a12
        if abs(det) < 1e-30:
            break
        b1, b2 = dot(r, du), dot(r, dv)
        su, sv = (b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det
        t = 1.0
        while t > 1e-4:
            nu, nv = clamp(u + t * su, v + t * sv)
            nq = surface.at(nu, nv)
            nerr = norm(sub(p, nq))
            if nerr < err:
                break
            t /= 2
        else:
            break
        moved = abs(nu - u) + abs(nv - v)
        u, v, q, err = nu, nv, nq, nerr
        if moved < 1e-13:
            break
    return (u, v)


def curvature_steps(surface: Surface, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
    """Steps in u and v for a surface without radii to go by: from how far its midpoints stray from chords over the
    face's range of parameters."""
    if not uvs:
        return None, None
    us, vs = [u for u, _ in uvs], [v for _, v in uvs]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    n = 12
    hu, hv = (u1 - u0) / n or 1e-6, (v1 - v0) / n or 1e-6
    worst_u = worst_v = 0.0
    for i in range(n + 1):
        for j in range(n + 1):
            u, v = u0 + hu * i, v0 + hv * j
            p = surface.at(u, v)
            a, b = surface.at(u - hu, v), surface.at(u + hu, v)
            worst_u = max(worst_u, norm(sub(p, mul(add(a, b), 0.5))) / (hu * hu))
            a, b = surface.at(u, v - hv), surface.at(u, v + hv)
            worst_v = max(worst_v, norm(sub(p, mul(add(a, b), 0.5))) / (hv * hv))
    return (math.sqrt(4 * tol / worst_u) if worst_u else None, math.sqrt(4 * tol / worst_v) if worst_v else None)


class BSurface(Surface):
    follows = True

    def __init__(self, spline: SplineSurface) -> None:
        self.s = spline
        self.u_period = spline.u1 - spline.u0 if spline.u_periodic else None
        self.v_period = spline.v1 - spline.v0 if spline.v_periodic else None
        self._grid: list[tuple[UV, Vec]] | None = None

    def at(self, u: float, v: float) -> Vec:
        return self.s.at(u, v)

    def grid(self) -> list[tuple[UV, Vec]]:
        # A few points for each knot span each way (a thread's surface winds many turns, and each needs its own), at
        # most about 40,000 in all.
        if self._grid is None:
            s = self.s
            nu, nv = max(8, 3 * s.u_spans * s.pu), max(8, 3 * s.v_spans * s.pv)
            if nu * nv > 40_000:
                k = math.sqrt(40_000 / (nu * nv))
                nu, nv = max(8, int(nu * k)), max(8, int(nv * k))
            self._grid = [
                ((u, v), self.at(u, v))
                for u in (s.u0 + (s.u1 - s.u0) * i / nu for i in range(nu + 1))
                for v in (s.v0 + (s.v1 - s.v0) * j / nv for j in range(nv + 1))
            ]
        return self._grid

    def from_grid(self, p: Vec) -> UV:
        """Newton from each of the three grid points nearest p: wherever comes closest."""
        best: tuple[float, UV] | None = None
        for (u, v), _ in sorted(self.grid(), key=lambda g: dot(sub(g[1], p), sub(g[1], p)))[:3]:
            found = newton_uv(self, p, u, v, self.s)
            gap = norm(sub(self.at(*found), p))
            if best is None or gap < best[0]:
                best = (gap, found)
        assert best is not None
        return best[1]

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        # From the last point's (u, v), as loops are smooth; where that leads elsewhere (a loop going on to another
        # turn of a thread), from the grid.
        if near is not None:
            found = newton_uv(self, p, *near, self.s)
            if norm(sub(self.at(*found), p)) < 1e-7:
                return found
        return self.from_grid(p)

    def project(self, p: Vec, near: UV | None = None) -> tuple[Vec, Vec, UV]:
        u, v = self.from_grid(p) if near is None else newton_uv(self, p, *near, self.s)
        return self.at(u, v), self.normal(u, v), (u, v)

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return curvature_steps(self, tol, uvs)


class Spun(Surface):
    """A profile curve spun round an axis: u the profile's parameter, v the angle."""

    v_period = TAU
    follows = True

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        self.profile = model.curve(f["profile"])
        self.p, self.a = f["base"], unit(f["axis"])
        self._samples: list[tuple[float, float, float, Vec]] | None = None

    def at(self, u: float, v: float) -> Vec:
        c = self.profile.at(u)
        z = add(self.p, mul(self.a, dot(sub(c, self.p), self.a)))
        r = sub(c, z)
        return add(z, add(mul(r, math.cos(v)), mul(cross(self.a, r), math.sin(v))))

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return curvature_steps(self, tol, uvs)

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        if near is not None:
            found = newton_uv(self, p, *near)
            if norm(sub(self.at(*found), p)) < 1e-7:
                return found
        # The profile's point at p's height along the axis and distance from it, then the angle round to p.
        if self._samples is None:
            t0, t1 = self.profile.range()
            self._samples = []
            for i in range(129):
                t = t0 + (t1 - t0) * i / 128
                c = self.profile.at(t)
                w = sub(c, self.p)
                z = dot(w, self.a)
                self._samples.append((t, z, norm(sub(w, mul(self.a, z))), c))
        w = sub(p, self.p)
        z = dot(w, self.a)
        rho = norm(sub(w, mul(self.a, z)))
        t, _, _, c = min(self._samples, key=lambda s: (s[1] - z) ** 2 + (s[2] - rho) ** 2)
        a = sub(c, add(self.p, mul(self.a, dot(sub(c, self.p), self.a))))
        b = sub(p, add(self.p, mul(self.a, z)))
        return newton_uv(self, p, t, math.atan2(dot(cross(a, b), self.a), dot(a, b)))


class Swept(Surface):
    """A section curve swept along a direction: u the section's parameter, v how far along."""

    follows = True

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        self.section = model.curve(f["section"])
        self.d = unit(f["sweep"])
        if self.section.period:
            self.u_period = self.section.period
        self._flat: list[tuple[float, Vec]] | None = None

    def at(self, u: float, v: float) -> Vec:
        return add(self.section.at(u), mul(self.d, v))

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return curvature_steps(self, tol, uvs)[0], None

    def flat(self, q: Vec) -> Vec:
        return sub(q, mul(self.d, dot(q, self.d)))

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        if near is not None:
            found = newton_uv(self, p, *near)
            if norm(sub(self.at(*found), p)) < 1e-7:
                return found
        # The section's point nearest p slid back along the sweep, then how far along the sweep p is.
        if self._flat is None:
            t0, t1 = self.section.range()
            self._flat = [(t, self.flat(self.section.at(t))) for t in (t0 + (t1 - t0) * i / 256 for i in range(257))]
        fp = self.flat(p)
        t = min(self._flat, key=lambda s: norm(sub(s[1], fp)))[0]
        return newton_uv(self, p, t, dot(sub(p, self.section.at(t)), self.d))


class Blend(Surface):
    """A rolling ball blend: the ball's centre runs along the spine, touching both supports. Here u is how far along
    the spine (sampled to a tenth of the tolerance), and v goes from 0 where the ball touches the first support to 1
    at the second (the other way round when the spine runs backwards). A cliff edge blend rolls along the edge of a
    face instead: its second support is a blend of no radius whose spine is that edge."""

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        if f["blend_type"] not in ("R", "E"):
            raise Unfollowed(f"A blend of a kind Caliper doesn't know ({f['blend_type']!r})")
        self.r = abs(f["range"][0]) or abs(f["range"][1])
        self.supports = [model.surface(i) for i in f["surface"]]
        self.backwards = model.node(f["spine"]).fields["sense"] == "-"
        self.spine = model.curve(f["spine"]).whole(model.tol / 10)
        if len(self.spine) < 2:
            raise Unfollowed("A blend's spine is a point")
        along = [0.0]
        for a, b in pairwise(self.spine):
            along.append(along[-1] + norm(sub(b, a)))
        self.along = along
        if norm(sub(self.spine[0], self.spine[-1])) < 1e-9:
            self.u_period = along[-1]
        # Parasolid's natural normal on a blend points away from its spine: flip where du x dv here points toward it.
        u, h = along[-1] / 2, 1e-6
        q = self.at(u, 0.5)
        n = cross(sub(self.at(u + h, 0.5), q), sub(self.at(u, 0.5 + h), q))
        self.flip = dot(n, sub(q, self.centre(u))) < 0

    def centre(self, u: float) -> Vec:
        along, spine = self.along, self.spine
        if self.u_period:
            u %= along[-1]
        u = min(max(u, 0.0), along[-1])
        lo, hi = 0, len(along) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if along[mid] <= u:
                lo = mid
            else:
                hi = mid
        seg = along[hi] - along[lo]
        return lerp(spine[lo], spine[hi], (u - along[lo]) / seg if seg else 0.0)

    def contacts(self, u: float) -> tuple[Vec, list[Vec]]:
        c = self.centre(u)
        return c, [nearest(s, c) for s in self.supports]

    def frame(self, u: float) -> tuple[Vec, Vec, Vec, float]:
        """The ball's centre at u, and the arc from one contact to the other: its axes and angle."""
        c, (q1, q2) = self.contacts(u)
        if self.backwards:
            q1, q2 = q2, q1
        a, b = sub(q1, c), sub(q2, c)
        x = unit(a)
        return c, x, unit(sub(b, mul(x, dot(b, x)))), math.atan2(norm(cross(a, b)), dot(a, b))

    def at(self, u: float, v: float) -> Vec:
        c, x, y, angle = self.frame(u)
        t = v * angle
        return add(c, mul(add(mul(x, math.cos(t)), mul(y, math.sin(t))), self.r))

    def along_spine(self, p: Vec) -> float:
        """How far along the spine its point nearest p is: the ball's centre, for a point of the blend."""
        best = (math.inf, 0.0)
        for i in range(len(self.spine) - 1):
            a, b = self.spine[i], self.spine[i + 1]
            ab = sub(b, a)
            length = dot(ab, ab)
            f = max(0.0, min(1.0, dot(sub(p, a), ab) / length)) if length else 0.0
            d = norm(sub(p, lerp(a, b, f)))
            if d < best[0]:
                best = (d, self.along[i] + f * (self.along[i + 1] - self.along[i]))
        return best[1]

    def uv(self, p: Vec, near: UV | None = None) -> UV:
        u = self.along_spine(p)
        c, x, y, angle = self.frame(u)
        w = sub(p, c)
        return (u, math.atan2(dot(w, y), dot(w, x)) / angle if angle else 0.0)

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        return None, angle_step(self.r, tol) / (math.pi / 2)


def nearest(surface: Surface, p: Vec) -> Vec:
    """Where a rolling ball centred at p touches a support: its nearest point; on a cliff, the edge's."""
    if isinstance(surface, Blend) and surface.r == 0:
        return surface.centre(surface.along_spine(p))
    return surface.nearest(p)


class Swapped(Surface):
    """A surface with u and v the other way round."""

    def __init__(self, s: Surface) -> None:
        self.s = s
        self.u_period, self.v_period = s.v_period, s.u_period

    def at(self, u: float, v: float) -> Vec:
        return self.s.at(v, u)

    def steps(self, tol: float, uvs: list[UV]) -> tuple[float | None, float | None]:
        a, b = self.s.steps(tol, [(v, u) for u, v in uvs])
        return b, a


# --- curves ------------------------------------------------------------------------------------------------------

Samples = list[tuple[float, Vec]]


class Curve:
    sense = "+"
    closed = False
    period: float | None = None

    def at(self, t: float) -> Vec:
        raise Unfollowed(f"A {type(self).__name__} can't be followed by its parameter")

    def param(self, p: Vec) -> float:
        raise Unfollowed(f"A {type(self).__name__} can't be followed by its parameter")

    def range(self) -> tuple[float, float]:
        raise Unfollowed(f"A {type(self).__name__} has no range of its own")

    def sample(self, t0: float, t1: float, tol: float) -> Samples:
        """Points from t0 to t1 whose chords stray from it by no more than tol."""
        return adaptive(self.at, t0, t1, tol, 8)

    def whole(self, tol: float) -> list[Vec]:
        t0, t1 = self.range()
        return [p for _, p in self.sample(t0, t1, tol)]


def adaptive(at: Callable[[float], Vec], t0: float, t1: float, tol: float, start: int, depth: int = 12) -> Samples:
    """Points of a curve from t0 to t1: start of them evenly, then halving each step whose midpoint strays from its
    chord by more than tol (or by a tenth of the chord, so a curve that turns back on itself isn't missed)."""
    out = [(t0, at(t0))]

    def halve(ta: float, pa: Vec, tb: float, pb: Vec, d: int) -> None:
        tm = (ta + tb) / 2
        pm = at(tm)
        chord = norm(sub(pb, pa))
        off = norm(sub(pm, mul(add(pa, pb), 0.5)))
        if d < depth and (off > tol or (chord > 0 and off > chord / 10)):
            halve(ta, pa, tm, pm, d + 1)
            halve(tm, pm, tb, pb, d + 1)
        else:
            out.append((tb, pb))

    for i in range(start):
        ta, tb = t0 + (t1 - t0) * i / start, t0 + (t1 - t0) * (i + 1) / start
        halve(ta, out[-1][1], tb, at(tb), 0)
    return out


def curve_param(at: Callable[[float], Vec], t0: float, t1: float, closed: bool, p: Vec, count: int) -> float:
    """p's parameter on a curve: from the nearest of samples fine enough for every span (a thread's helix winds many
    turns, and coarser samples find the wrong one), then Newton, each step halved until it brings the point closer."""
    t = min((t0 + (t1 - t0) * i / count for i in range(count + 1)), key=lambda t: norm(sub(at(t), p)))
    h = 1e-7
    q = at(t)
    err = norm(sub(p, q))
    for _ in range(40):
        d = mul(sub(at(t + h), q), 1 / h)
        dd = dot(d, d)
        if dd == 0 or err < 1e-13:
            break
        step = dot(sub(p, q), d) / dd
        k = 1.0
        while k > 1e-4:
            nt = t + k * step
            if not closed:
                nt = min(max(nt, t0), t1)
            nq = at(nt)
            if norm(sub(p, nq)) < err:
                break
            k /= 2
        else:
            break
        t, q, err = nt, nq, norm(sub(p, nq))
    return t


class Line(Curve):
    def __init__(self, f: dict[str, Any]) -> None:
        self.p, self.d = f["pvec"], unit(f["direction"])

    def at(self, t: float) -> Vec:
        return add(self.p, mul(self.d, t))

    def param(self, p: Vec) -> float:
        return dot(sub(p, self.p), self.d)

    def sample(self, t0: float, t1: float, tol: float) -> Samples:
        return [(t0, self.at(t0)), (t1, self.at(t1))]


class Ellipse(Curve):
    """An ellipse, or with equal radii a circle."""

    closed = True
    period = TAU

    def __init__(self, centre: Vec, normal: Vec, x: Vec, a: float, b: float) -> None:
        if a <= 0 or b <= 0:
            raise Unfollowed("A circle or ellipse has no size")
        self.c, self.x, self.a, self.b = centre, unit(x), a, b
        self.y = cross(unit(normal), self.x)

    def at(self, t: float) -> Vec:
        return add(self.c, add(mul(self.x, self.a * math.cos(t)), mul(self.y, self.b * math.sin(t))))

    def param(self, p: Vec) -> float:
        w = sub(p, self.c)
        return math.atan2(dot(w, self.y) / self.b, dot(w, self.x) / self.a)

    def range(self) -> tuple[float, float]:
        return 0.0, TAU

    def sample(self, t0: float, t1: float, tol: float) -> Samples:
        # Its tightest curve, at the ends of its major axis, has radius b^2 / a.
        n = max(2, math.ceil(abs(t1 - t0) / angle_step(self.b * self.b / self.a, tol)))
        return [(t, self.at(t)) for t in (t0 + (t1 - t0) * i / n for i in range(n + 1))]


class BCurve(Curve):
    def __init__(self, spline: Spline) -> None:
        self.s = spline
        self.closed = spline.periodic
        self.period = spline.t1 - spline.t0 if spline.periodic else None

    def at(self, t: float) -> Vec:
        p = self.s.at(t)
        return (p[0], p[1], p[2])

    def range(self) -> tuple[float, float]:
        return self.s.t0, self.s.t1

    def param(self, p: Vec) -> float:
        s = self.s
        return curve_param(self.at, s.t0, s.t1, self.closed, p, max(64, 8 * s.degree * s.spans))

    def sample(self, t0: float, t1: float, tol: float) -> Samples:
        return adaptive(self.at, t0, t1, tol, max(4, 2 * self.s.degree * max(1, self.s.spans)))


class SPCurve(Curve):
    """A curve in a surface's parameters: a 2D B-spline of (u, v)."""

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        self.surface_index = f["surface"]
        self.surface = model.surface(f["surface"])
        flat = model.node(f["b_curve"])
        if flat.fields["sense"] != "+":
            raise Unfollowed("A curve in a surface's parameters runs backwards")
        self.uvs = model.spline(flat.fields["nurbs"])
        self.closed = self.uvs.periodic
        self.period = self.uvs.t1 - self.uvs.t0 if self.uvs.periodic else None

    def uv_at(self, t: float) -> UV:
        p = self.uvs.at(t)
        return (p[0], p[1])

    def at(self, t: float) -> Vec:
        return self.surface.at(*self.uv_at(t))

    def range(self) -> tuple[float, float]:
        return self.uvs.t0, self.uvs.t1

    def param(self, p: Vec) -> float:
        s = self.uvs
        return curve_param(self.at, s.t0, s.t1, self.closed, p, max(64, 8 * s.degree * s.spans))

    def sample(self, t0: float, t1: float, tol: float) -> Samples:
        return adaptive(self.at, t0, t1, tol, max(4, 2 * self.uvs.degree * max(1, self.uvs.spans)))


class _BlendBound:
    """Where a blend meets a support: the curve the ball touches it along (the reference doesn't say more of it)."""

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        blend = model.surface(f["blend"])
        if not isinstance(blend, Blend) or f["boundary"] not in (0, 1):
            raise Unfollowed("A blend's boundary doesn't belong to a blend")
        self.blend, self.support = blend, 1 - f["boundary"]


class Intersection(Curve):
    """Where two surfaces meet. The file keeps a chart of points along it, often far apart, so between them points
    are found on both surfaces: Newton, each step along both normals at once."""

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        chart = model.node(f["chart"]).fields
        start, end = model.node(f["start"]).fields, model.node(f["end"]).fields
        self.pts: list[Vec] = list(chart["hvec"])
        # A terminator's true end lies just past the chart's; a help point means the curve is closed.
        if start["type"] == "T" and start["hvec"]:
            self.pts.insert(0, start["hvec"][0])
        if end["type"] == "T" and end["hvec"]:
            self.pts.append(end["hvec"][0])
        if len(self.pts) < 2:
            raise Unfollowed("An intersection's chart has fewer than two points")
        self.closed = start["type"] == "H" or norm(sub(self.pts[0], self.pts[-1])) < 1e-12
        self.surfaces: list[Surface | _BlendBound] = []
        for i in f["surface"]:
            node = model.node(i)
            self.surfaces.append(_BlendBound(node.fields, model) if node.type == 59 else model.surface(i))
        self.hints: list[UV | None] = [None, None]

    def onto(self, x: Vec) -> Vec:
        """The curve's point near x."""
        for s in self.surfaces:
            if isinstance(s, _BlendBound):
                return s.blend.contacts(s.blend.along_spine(x))[1][s.support]
        a, b = self.surfaces
        assert isinstance(a, Surface) and isinstance(b, Surface)
        for _ in range(16):
            p1, n1, self.hints[0] = a.project(x, self.hints[0])
            p2, n2, self.hints[1] = b.project(x, self.hints[1])
            r1, r2 = dot(n1, sub(p1, x)), dot(n2, sub(p2, x))
            c = dot(n1, n2)
            det = 1 - c * c
            if det < 1e-8:  # the surfaces touch here: between their points is as near as it gets
                x = mul(add(p1, p2), 0.5)
                continue
            d = add(mul(n1, (r1 - c * r2) / det), mul(n2, (r2 - c * r1) / det))
            x = add(x, d)
            if norm(d) < 1e-12:
                break
        return x

    def refine(self, pts: list[Vec], tol: float, depth: int = 10) -> list[Vec]:
        """Points between these, where their chords stray from the curve by more than tol."""
        # Each run starts its surfaces' (u, v) afresh, then follows the curve along.
        self.hints = [None if isinstance(s, _BlendBound) else s.project(pts[0])[2] for s in self.surfaces]
        out = [pts[0]]

        def halve(a: Vec, b: Vec, d: int) -> None:
            m = mul(add(a, b), 0.5)
            c = self.onto(m)
            off = norm(sub(c, m))
            if d < depth and tol < off < norm(sub(b, a)):
                halve(a, c, d + 1)
                halve(c, b, d + 1)
            else:
                out.append(b)

        for a, b in pairwise(pts):
            halve(a, b, 0)
        return out

    def locate(self, p: Vec) -> float:
        """Where p falls along the chart: a segment's index plus how far along it."""
        best = (math.inf, 0.0)
        for i in range(len(self.pts) - 1):
            a, b = self.pts[i], self.pts[i + 1]
            ab = sub(b, a)
            length = dot(ab, ab)
            f = max(0.0, min(1.0, dot(sub(p, a), ab) / length)) if length else 0.0
            d = norm(sub(p, lerp(a, b, f)))
            if d < best[0]:
                best = (d, i + f)
        return best[1]

    def between(self, p: Vec, q: Vec, forward: bool, tol: float, around: bool = False) -> list[Vec]:
        """The curve from p to q, with the chart or against it; all the way round from p to itself when around."""
        s, e = self.locate(p), self.locate(q)
        n = len(self.pts) - 1
        if around:  # an edge from a point round to itself: the curve is closed, wherever its chart stops
            self.closed = True
            e = s + n if forward else s - n
        out = [p]
        if forward:
            if e < s - 1e-9 and self.closed:
                e += n
            k = math.floor(s) + 1
            while k < e - 1e-9:
                out.append(self.pts[k % n] if self.closed else self.pts[k])
                k += 1
        else:
            if e > s + 1e-9 and self.closed:
                e -= n
            k = math.ceil(s) - 1
            while k > e + 1e-9:
                out.append(self.pts[k % n] if self.closed else self.pts[k])
                k -= 1
        out.append(q)
        return self.refine(out, tol)

    def whole(self, tol: float) -> list[Vec]:
        return self.refine(list(self.pts), tol)


class Trimmed(Curve):
    """A stretch of another curve, from point_1 at parm_1 to point_2 at parm_2."""

    def __init__(self, f: dict[str, Any], model: "Model") -> None:
        self.basis = model.curve(f["basis_curve"])
        self.forward = model.node(f["basis_curve"]).fields["sense"] == "+"
        self.p1, self.p2, self.t1, self.t2 = f["point_1"], f["point_2"], f["parm_1"], f["parm_2"]


# --- the solid ---------------------------------------------------------------------------------------------------


class Model:
    """A transmit file's surfaces and curves, made as they're needed."""

    def __init__(self, nodes: dict[int, Node], tol: float) -> None:
        self.nodes, self.tol = nodes, tol
        self._surfaces: dict[int, Surface] = {}
        self._curves: dict[int, Curve] = {}

    def node(self, index: int) -> Node:
        node = self.nodes.get(index)
        if node is None:
            raise Unfollowed(f"Its node {index} is missing")
        return node

    def values(self, index: int, name: str) -> list[Any]:
        return list(self.node(index).fields[name])

    def knots(self, knots: int, mults: int, count: int) -> tuple[list[float], list[int]]:
        """A spline's distinct knots and their multiplicities: the first count of each (Parasolid's arrays can run on
        past them, with null knots of multiplicity 0)."""
        return self.values(knots, "knots")[:count], self.values(mults, "mult")[:count]

    def spline(self, index: int) -> Spline:
        f = self.node(index).fields
        knots, mults = self.knots(f["knots"], f["knot_mult"], f["n_knots"])
        verts = self.values(f["bspline_vertices"], "vertices")[: f["n_vertices"] * f["vertex_dim"]]
        return Spline(f["degree"], verts, f["vertex_dim"], knots, mults, bool(f["rational"]), bool(f["periodic"]))

    def surface(self, index: int) -> Surface:
        if index in self._surfaces:
            return self._surfaces[index]
        node = self.node(index)
        f = node.fields
        made: Surface
        if node.name == "PLANE":
            made = Plane(f)
        elif node.name == "CYLINDER":
            made = Cylinder(f)
        elif node.name == "CONE":
            made = Cone(f)
        elif node.name == "SPHERE":
            made = Sphere(f)
        elif node.name == "TORUS":
            made = Torus(f)
        elif node.name == "B_SURFACE":
            n = self.node(f["nurbs"]).fields
            u_knots, u_mults = self.knots(n["u_knots"], n["u_knot_mult"], n["n_u_knots"])
            v_knots, v_mults = self.knots(n["v_knots"], n["v_knot_mult"], n["n_v_knots"])
            verts = self.values(n["bspline_vertices"], "vertices")
            verts = verts[: n["n_u_vertices"] * n["n_v_vertices"] * n["vertex_dim"]]
            made = BSurface(SplineSurface(n, verts, u_knots, v_knots, u_mults, v_mults))
        elif node.name == "BLENDED_EDGE":
            self._surfaces[index] = _Pending()  # a blend's supports can't be the blend itself
            made = Blend(f, self)
        elif node.name == "SPUN_SURF":
            made = Spun(f, self)
        elif node.name == "SWEPT_SURF":
            made = Swept(f, self)
        else:
            raise Unfollowed(f"It has a surface of a kind Caliper doesn't follow ({node.name})")
        made.sense = f["sense"]
        self._surfaces[index] = made
        return made

    def curve(self, index: int) -> Curve:
        if index in self._curves:
            return self._curves[index]
        node = self.node(index)
        f = node.fields
        made: Curve
        if node.name == "LINE":
            made = Line(f)
        elif node.name == "CIRCLE":
            made = Ellipse(f["centre"], f["normal"], f["x_axis"], f["radius"], f["radius"])
        elif node.name == "ELLIPSE":
            made = Ellipse(f["centre"], f["normal"], f["x_axis"], f["major_radius"], f["minor_radius"])
        elif node.name == "B_CURVE":
            made = BCurve(self.spline(f["nurbs"]))
        elif node.name == "SP_CURVE":
            made = SPCurve(f, self)
        elif node.name == "INTERSECTION":
            made = Intersection(f, self)
        elif node.name == "TRIMMED_CURVE":
            made = Trimmed(f, self)
        else:
            raise Unfollowed(f"It has a curve of a kind Caliper doesn't follow ({node.name})")
        made.sense = f["sense"]
        self._curves[index] = made
        return made

    def point(self, vertex: int) -> Vec:
        return self.node(self.node(vertex).fields["point"]).fields["pvec"]


class _Pending(Surface):
    def at(self, u: float, v: float) -> Vec:
        raise Unfollowed("A blend supports itself")


Polyline = tuple[list[Vec], list[UV] | None, int | None]


def polyline(curve: Curve, start: Vec | None, end: Vec | None, tol: float) -> Polyline:
    """An edge's points from start to end, along the edge (its curve's direction, unless its sense says otherwise);
    for a curve in a surface's parameters, their (u, v) on it too, and which surface that is. A ring edge (one with
    no vertices) is its whole closed curve."""
    if isinstance(curve, Trimmed):
        basis = curve.basis
        if isinstance(basis, Intersection):
            around = norm(sub(curve.p1, curve.p2)) < 1e-9 and curve.t1 != curve.t2
            return basis.between(curve.p1, curve.p2, curve.forward, tol, around), None, None
        if isinstance(basis, Line):
            return [curve.p1, curve.p2], None, None
        samples = basis.sample(curve.t1, curve.t2, tol)
        pts = [p for _, p in samples]
        pts[0], pts[-1] = curve.p1, curve.p2
        if isinstance(basis, SPCurve):
            return pts, [basis.uv_at(t) for t, _ in samples], basis.surface_index
        return pts, None, None
    forward = curve.sense == "+"
    ring = start is None or end is None
    if isinstance(curve, Intersection):
        if ring:
            pts = curve.whole(tol)
            return (pts if forward else pts[::-1]), None, None
        assert start is not None and end is not None
        return curve.between(start, end, forward, tol), None, None
    if isinstance(curve, Line):
        if start is None or end is None:
            raise Unfollowed("A straight edge has no ends")
        return [start, end], None, None
    if ring:
        if curve.period is None:
            raise Unfollowed("A closed edge is on an open curve")
        t0 = curve.range()[0]
        samples = curve.sample(t0, t0 + curve.period if forward else t0 - curve.period, tol)
    else:
        assert start is not None and end is not None
        t0, t1 = curve.param(start), curve.param(end)
        if curve.period:
            while forward and t1 <= t0 + 1e-12:
                t1 += curve.period
            while not forward and t1 >= t0 - 1e-12:
                t1 -= curve.period
        samples = curve.sample(t0, t1, tol)
    pts = [p for _, p in samples]
    if not ring:
        pts[0], pts[-1] = start, end  # type: ignore[assignment]
    if isinstance(curve, SPCurve):
        return pts, [curve.uv_at(t) for t, _ in samples], curve.surface_index
    return pts, None, None


@dataclass
class Face:
    positions: list[Vec]  # in meters, as Parasolid's
    triangles: list[tuple[int, int, int]]
    color: Rgb | None = None  # its own (SDL/TYSA_COLOUR), where it has one


@dataclass
class Solid:
    faces: list[Face]
    solid: bool  # a closed volume, which sections fill; else a sheet


def _chain(nodes: dict[int, Node], first: int, step: str) -> list[int]:
    """A chain of nodes from first, each to the next by its field step, until none or back where it started."""
    out, seen, at = [], set(), first
    while at and at in nodes and at not in seen:
        seen.add(at)
        out.append(at)
        at = nodes[at].fields[step]
    return out


def _colours(nodes: dict[int, Node]) -> dict[int, Rgb]:
    """The colours given to faces and bodies (Parasolid's colour attribute), by their nodes' index."""
    defs = {
        i
        for i, n in nodes.items()
        if n.name == "ATTRIB_DEF" and nodes.get(n.fields["identifier"], Node(0, "")).fields.get("string") == "SDL/TYSA_COLOUR"
    }  # fmt: skip
    out: dict[int, Rgb] = {}
    for n in nodes.values():
        if n.name == "ATTRIBUTE" and n.fields["definition"] in defs and n.fields["fields"]:
            values = nodes.get(n.fields["fields"][0])
            rgb = list(values.fields.get("values", [])) if values is not None else []
            if len(rgb) == 3 and all(0 <= c <= 1 for c in rgb):
                out[n.fields["owner"]] = (rgb[0], rgb[1], rgb[2])
    return out


def solids(nodes: dict[int, Node]) -> list[Solid]:
    """A transmit file's bodies, as triangles. Anything it can't follow is refused (Unfollowed)."""
    try:
        return _solids(nodes)
    except (KeyError, TypeError, IndexError, ValueError, AttributeError, AssertionError, ZeroDivisionError,
            OverflowError, RecursionError) as e:  # fmt: skip
        if isinstance(e, XtError):
            raise
        raise Unfollowed(f"Its solid doesn't fit together ({type(e).__name__})") from e


def _solids(nodes: dict[int, Node]) -> list[Solid]:
    bodies = [i for i, n in nodes.items() if n.name == "BODY"]
    points = [n.fields["pvec"] for n in nodes.values() if n.name == "POINT"]
    size = math.dist([min(p[k] for p in points) for k in range(3)], [max(p[k] for p in points) for k in range(3)]) if points else 0.01  # fmt: skip
    tol = max(2e-6, size * 5e-4)  # chords within 0.05% of the part's size (and 2 microns)
    model = Model(nodes, tol)
    colours = _colours(nodes)
    edges: dict[int, Polyline] = {}

    def edge(index: int) -> Polyline:
        if index not in edges:
            f = model.node(index).fields
            fins = [model.node(i).fields for i in _chain(nodes, f["fin"], "other")]
            # The edge runs from its negative fin's vertex to its positive fin's (each fin's vertex is the one it
            # runs to); one with neither is a ring, its curve all the way round.
            plus = next((fin for fin in fins if fin["sense"] == "+"), None)
            minus = next((fin for fin in fins if fin["sense"] == "-"), None)
            end = model.point(plus["vertex"]) if plus and plus["vertex"] else None
            start = model.point(minus["vertex"]) if minus and minus["vertex"] else None
            edges[index] = polyline(model.curve(f["curve"]), start, end, tol)
        return edges[index]

    faces_of: dict[int, list[int]] = {b: [] for b in bodies}
    for i, n in nodes.items():
        if n.name == "FACE":
            shell = nodes.get(n.fields["shell"]) or nodes.get(n.fields["front_shell"])
            region = nodes.get(shell.fields["region"]) if shell is not None else None
            if region is not None and region.fields["body"] in faces_of:
                faces_of[region.fields["body"]].append(i)
    out, triangles = [], 0
    for b in bodies:
        faces = []
        for i in faces_of[b]:
            face = _face(model, i, edge, tol)
            face.color = colours.get(i) or colours.get(b)
            triangles += len(face.triangles)
            if triangles > MAX_TRIANGLES:
                raise Unfollowed(f"It makes over {MAX_TRIANGLES:,} triangles, more than Caliper shows")
            faces.append(face)
        out.append(Solid(faces, nodes[b].fields["body_type"] == 1))
    return out


def _face(model: Model, index: int, edge: Callable[[int], Polyline], tol: float) -> Face:
    f = model.node(index).fields
    surface = model.surface(f["surface"])
    loops: list[tuple[list[Vec], list[UV | None]]] = []
    for loop in _chain(model.nodes, f["loop"], "next"):
        pts: list[Vec] = []
        uvs: list[UV | None] = []
        first = model.node(loop).fields["fin"]
        for fin_index in _chain(model.nodes, first, "forward"):
            fin = model.node(fin_index).fields
            if not fin["edge"]:
                continue  # a loop of one vertex: a point, nothing to draw
            if model.node(fin["edge"]).fields["curve"]:
                ep, euv, on = edge(fin["edge"])
                seg = list(ep if fin["sense"] == "+" else ep[::-1])
                suv = (euv if fin["sense"] == "+" else euv[::-1]) if euv and on == f["surface"] else None
            elif fin["curve"]:
                # A tolerant edge has no curve: each of its fins has one in its own face's surface, along the fin.
                ep, suv, on = polyline(model.curve(fin["curve"]), None, None, tol)
                seg = list(ep)
                suv = suv if on == f["surface"] else None
            else:
                raise Unfollowed("A tolerant edge has no curves")
            # A fin's ends are its vertices, which the faces either side share: a tolerant edge's curves may end up
            # to its tolerance away, which can fold a loop back on itself.
            if fin["vertex"]:
                seg[-1] = model.point(fin["vertex"])
            back = model.node(fin["backward"]).fields if fin["backward"] else None
            if back is not None and back["vertex"]:
                seg[0] = model.point(back["vertex"])
            own: list[UV | None] = list(suv) if suv else [None] * len(seg)
            skip = 1 if pts else 0
            pts.extend(seg[skip:])
            uvs.extend(own[skip:])
        if len(pts) >= 2 and norm(sub(pts[0], pts[-1])) < 1e-9:
            pts, uvs = pts[:-1], uvs[:-1]
        if len(pts) >= 3:
            loops.append((pts, uvs))
    natural = f["sense"] == surface.sense  # the face's normal is its surface's
    try:
        positions, triangles = _strips(surface, loops, natural != surface.flip, tol)
    except Unfollowed:
        if isinstance(surface, Plane) and _sliver(surface, loops, tol):
            return Face([], [])  # thinner than the tolerance, so nothing to see, and its loops cross each other
        raise
    return Face(positions, triangles)


def _sliver(surface: Plane, loops: list[tuple[list[Vec], list[UV | None]]], tol: float) -> bool:
    """Whether a plane face is thinner than tol: its area (its outer loop's less its holes') under its perimeter's
    times tol."""
    area = perimeter = 0.0
    for pts, _ in loops:
        uv = [surface.uv(p) for p in pts]
        n = len(uv)
        area += sum(uv[i][0] * uv[(i + 1) % n][1] - uv[(i + 1) % n][0] * uv[i][1] for i in range(n)) / 2
        perimeter += sum(math.dist(uv[i], uv[(i + 1) % n]) for i in range(n))
    return abs(area) < perimeter * tol


# --- a face in its surface's parameters --------------------------------------------------------------------------


def _loop_uv(surface: Surface, pts: list[Vec], known: list[UV | None]) -> tuple[list[UV], list[Vec]]:
    """A loop's (u, v), unwrapped along it (a periodic surface's u goes on past its period rather than jumping back).
    Its points on a pole or apex, where u is anything, become two: at their neighbours' u."""
    uv: list[tuple[float | None, float]] = []
    near: UV | None = None
    for p, given in zip(pts, known, strict=True):
        pole = surface.singular(p)
        if pole is not None:
            uv.append((None, pole))
            continue
        u, v = given if given is not None else surface.uv(p, near)
        if surface.follows:
            near = (u, v)
        last = next(((a, b) for a, b in reversed(uv) if a is not None), None)
        if last is not None:
            if surface.u_period:
                u += round((last[0] - u) / surface.u_period) * surface.u_period
            if surface.v_period:
                v += round((last[1] - v) / surface.v_period) * surface.v_period
        uv.append((u, v))
    if all(u is None for u, _ in uv):
        raise Unfollowed("A face's loop is all one pole")
    out_uv: list[UV] = []
    out_pts: list[Vec] = []
    n = len(uv)
    for i, (u, v) in enumerate(uv):
        if u is not None:
            out_uv.append((u, v))
            out_pts.append(pts[i])
            continue
        before = next(x for k in range(1, n) if (x := uv[(i - k) % n][0]) is not None)
        after = next(x for k in range(1, n) if (x := uv[(i + k) % n][0]) is not None)
        out_uv += [(before, v), (after, v)]
        out_pts += [pts[i], pts[i]]
    return out_uv, out_pts


Segment = tuple[UV, UV, Vec, Vec]  # its ends in (u, v), and in space
Corner = tuple[UV, tuple[Any, ...], Any]  # where, a key that names the point (so cells share it), and whose it is


def _strips(surface: Surface, loops3d: list[tuple[list[Vec], list[UV | None]]], natural: bool,
            tol: float) -> tuple[list[Vec], list[tuple[int, int, int]]]:  # fmt: skip
    """A face's triangles: its loops in its surface's (u, v), cut into strips at every boundary point's u (and where
    the surface curves), each strip into cells between the boundaries crossing it, and those at steps of v."""
    loops = [_loop_uv(surface, pts, known) for pts, known in loops3d]
    if not loops:
        return _whole(surface, natural, tol)
    # How many times each loop goes round each period: a loop round the period bounds a band, not a patch.
    wraps_u = [round((uv[0][0] - uv[-1][0]) / surface.u_period) if surface.u_period else 0 for uv, _ in loops]
    wraps_v = [round((uv[0][1] - uv[-1][1]) / surface.v_period) if surface.v_period else 0 for uv, _ in loops]
    if any(wraps_u) and any(wraps_v):
        raise Unfollowed("A face's loops go round both ways")
    if any(wraps_u) or any(wraps_v):
        swap = any(wraps_v)  # strips across the way the loops go round
    else:
        # Either way will do: the one that makes fewer cells (strips at every boundary point, times steps of v).
        uvs = [p for uv, _ in loops for p in uv]
        us, vs = [u for u, _ in uvs], [v for _, v in uvs]
        su, sv = surface.steps(tol, uvs)
        ur, vr = max(us) - min(us), max(vs) - min(vs)
        cuts_u = len(set(us)) + (ur / su if su else 0)
        cuts_v = len(set(vs)) + (vr / sv if sv else 0)
        swap = cuts_v * max(1.0, ur / su if su else 1.0) < cuts_u * max(1.0, vr / sv if sv else 1.0)
    s: Surface = Swapped(surface) if swap else surface
    if swap:
        loops = [([(v, u) for u, v in uv], pts) for uv, pts in loops]
        natural = not natural  # (v, u) turns the face over
    wraps = wraps_v if swap else wraps_u
    period, cross_period = s.u_period, s.v_period
    lo_v, hi_v = (None, None) if swap else (s.v_min, s.v_max)
    round_u = any(wraps)
    if period and not round_u and len(loops) > 1:
        # A patch: each loop within half a period of the widest (atan2 may have put a hole a period away).
        widest = max(loops, key=lambda lp: max(u for u, _ in lp[0]) - min(u for u, _ in lp[0]))
        centre = sum(u for u, _ in widest[0]) / len(widest[0])
        loops = [
            ([(u + round((centre - sum(a for a, _ in uv) / len(uv)) / period) * period, v) for u, v in uv], pts)
            for uv, pts in loops
        ]
    if round_u:
        assert period
        w0 = min(u for uv, _ in loops for u, _ in uv)
        window = (w0, w0 + period)
    segs: list[Segment] = []
    for li, (uv, pts) in enumerate(loops):
        n = len(uv)
        copies = [0]
        if round_u:
            # Every copy of the loop a period over that reaches into the window.
            lo = min(u for u, _ in uv)
            hi = max(u for u, _ in uv) + abs(wraps[li]) * period
            copies = list(range(math.ceil((window[0] - hi) / period) - 1, math.floor((window[1] - lo) / period) + 2))
        for k in copies:
            off = k * period if round_u else 0.0
            for i in range(n):
                a, b = uv[i], uv[(i + 1) % n]
                if i == n - 1 and wraps[li]:
                    b = (b[0] - wraps[li] * period, b[1])  # round the period: on into the next
                if cross_period and i == n - 1 and not wraps[li]:
                    b = (b[0], b[1] - round((b[1] - a[1]) / cross_period) * cross_period)
                segs.append(((a[0] + off, a[1]), (b[0] + off, b[1]), pts[i], pts[(i + 1) % n]))
    if not round_u:
        window = (min(a[0] for a, _, _, _ in segs), max(a[0] for a, _, _, _ in segs))
    # Round a period of v too, its window starts at a boundary point, so the seam falls on a boundary where it can.
    v0 = loops[0][0][0][1] if cross_period else 0.0
    uvs = [p for uv, _ in loops for p in uv]
    su, sv = s.steps(tol, uvs)
    cuts = {u for a, b, _, _ in segs for u in (a[0], b[0]) if window[0] <= u <= window[1]} | set(window)
    if cross_period:
        # Where a boundary crosses the seam, a cut, so that within a strip none does.
        for a, b, _, _ in segs:
            if a[1] == b[1]:
                continue
            for k in range(math.ceil((min(a[1], b[1]) - v0) / cross_period), math.floor((max(a[1], b[1]) - v0) / cross_period) + 1):  # fmt: skip
                vk = v0 + k * cross_period
                if min(a[1], b[1]) < vk < max(a[1], b[1]):
                    u = a[0] + (b[0] - a[0]) * (vk - a[1]) / (b[1] - a[1])
                    if window[0] < u < window[1]:
                        cuts.add(u)
    if su:
        steps = int((window[1] - window[0]) / su)
        if steps > 200_000:
            raise Unfollowed("A face is too big for its tolerance")
        cuts |= {window[0] + su * i for i in range(1, steps + 1) if window[0] < window[0] + su * i < window[1]}
    cuts_sorted = sorted(cuts)
    bands: list[float] | None = None
    if sv:
        if cross_period:
            bands = [v0 + sv * k for k in range(int(cross_period / sv) + 2)]
        else:
            vs = [v for _, v in uvs] + [b for b in (lo_v, hi_v) if b is not None]
            bands = [sv * k for k in range(math.floor(min(vs) / sv), math.ceil(max(vs) / sv) + 1)]
        if len(bands) > 200_000:
            raise Unfollowed("A face is too big for its tolerance")

    positions: list[Vec] = []
    index: dict[tuple[Any, ...], int] = {}
    triangles: list[tuple[int, int, int]] = []

    def vertex(corner: Corner) -> int:
        (u, v), key, owner = corner
        i = index.get(key)
        if i is None:
            i = index[key] = len(positions)
            if key[0] in ("s", "x"):  # on a boundary's chord: as the faces beside it have it
                a, b, pa, pb = segs[owner]
                positions.append(lerp(pa, pb, (u - a[0]) / (b[0] - a[0])))
            else:
                positions.append(s.at(u, v))
        return i

    order = sorted(range(len(segs)), key=lambda i: min(segs[i][0][0], segs[i][1][0]))
    active: list[int] = []
    taken = 0
    bound = {"min": lo_v, "max": hi_v, "seam0": v0, "seam1": v0 + (cross_period or 0.0)}
    for line in range(len(cuts_sorted) - 1):
        ua, ub = cuts_sorted[line], cuts_sorted[line + 1]
        if ub - ua < 1e-12:
            continue
        um = (ua + ub) / 2
        while taken < len(order) and min(segs[order[taken]][0][0], segs[order[taken]][1][0]) < ub:
            active.append(order[taken])
            taken += 1
        active = [i for i in active if max(segs[i][0][0], segs[i][1][0]) > ua]
        crossing = []
        for i in active:
            a, b, _, _ = segs[i]
            if min(a[0], b[0]) <= ua + 1e-12 and max(a[0], b[0]) >= ub - 1e-12 and abs(b[0] - a[0]) > 1e-12:
                vm = a[1] + (b[1] - a[1]) * (um - a[0]) / (b[0] - a[0])
                shift = -math.floor((vm - v0) / cross_period) * cross_period if cross_period else 0.0
                # The face is on a boundary's left: above it where the boundary runs towards +u, as (u, v) are.
                crossing.append((vm + shift, i, (b[0] > a[0]) == natural, shift))
        crossing.sort()
        try:
            regions = _regions(crossing, cross_period, lo_v, hi_v)
        except Unfollowed:
            # Where a loop turns back on itself sharply (a thread's runout), the chords either side of the turn can
            # cross, so a boundary that should be above the other is below it, by less than the tolerance: those
            # pairs go, and what's between them, which is too thin to see.
            def at(i: int, um: float = um) -> Vec:
                a, b, pa, pb = segs[i]
                return lerp(pa, pb, (um - a[0]) / (b[0] - a[0]))

            kept = list(crossing)
            k = 0
            while k < len(kept) - 1:
                if not kept[k][2] and kept[k + 1][2] and norm(sub(at(kept[k][1]), at(kept[k + 1][1]))) < 2 * tol:
                    del kept[k : k + 2]
                    k = max(k - 1, 0)
                else:
                    k += 1
            regions = _regions(kept, cross_period, lo_v, hi_v)

        def side(owner: Any, shift: float, u: float, at: int) -> Corner:
            if isinstance(owner, str):
                return (u, bound[owner]), ("b", owner, at), owner
            a, b, _, _ = segs[owner]
            return (u, a[1] + (b[1] - a[1]) * (u - a[0]) / (b[0] - a[0]) + shift), ("s", owner, at), owner

        for (lo_i, lo_s), (hi_i, hi_s) in regions:
            cell = [side(lo_i, lo_s, ua, line), side(lo_i, lo_s, ub, line + 1),
                    side(hi_i, hi_s, ub, line + 1), side(hi_i, hi_s, ua, line)]  # fmt: skip
            for polygon in _banded(cell, bands) if bands else [cell]:
                ids = [vertex(corner) for corner in polygon]
                for k in range(1, len(ids) - 1):
                    a, b, c = ids[0], ids[k], ids[k + 1]
                    if a != b and b != c and a != c:
                        triangles.append((a, b, c) if natural else (a, c, b))
    return positions, triangles


def _regions(crossing: list[tuple[float, int, bool, float]], cross_period: float | None, lo_v: float | None,
             hi_v: float | None) -> list[tuple[tuple[Any, float], tuple[Any, float]]]:  # fmt: skip
    """The regions of a strip, each from the boundary it starts at to the one it ends at (or a bound of v, or the
    seam of its period), from the boundaries crossing it, in order of v: where each opens or closes the face."""
    regions: list[tuple[tuple[Any, float], tuple[Any, float]]] = []
    depth = 0
    if cross_period:
        # Round the period: the regions open at the seam are those that boundaries below any start close.
        low = 0
        for _, _, opens, _ in crossing:
            depth += 1 if opens else -1
            low = min(low, depth)
        depth = -low
    bottom: tuple[Any, float] = ("seam0", 0.0)
    for _, i, opens, shift in crossing:
        if opens:
            if depth == 0:
                bottom = (i, shift)
            depth += 1
        elif depth == 0:
            if lo_v is None:
                raise Unfollowed("A face's boundaries leave it open below")
            regions.append((("min", 0.0), (i, shift)))
        else:
            depth -= 1
            if depth == 0:
                regions.append((bottom, (i, shift)))
    if depth > 0:
        if cross_period:
            regions.append((bottom, ("seam1", 0.0)))
        elif hi_v is None:
            raise Unfollowed("A face's boundaries leave it open above")
        else:
            regions.append((bottom, ("max", 0.0)))
    return regions


def _whole(surface: Surface, natural: bool, tol: float) -> tuple[list[Vec], list[tuple[int, int, int]]]:
    """A face without loops: all of a closed surface (a sphere, a torus)."""
    v_ends = (surface.v_min, surface.v_max) if surface.v_min is not None and surface.v_max is not None else None
    if not surface.u_period or not (surface.v_period or v_ends):
        raise Unfollowed("A face without edges is on an open surface")
    v0, v1 = v_ends if v_ends else (0.0, surface.v_period or TAU)
    su, sv = surface.steps(tol, [(0.0, v0), (surface.u_period, v1)])
    nu = max(3, math.ceil(surface.u_period / (su or surface.u_period / 24)))
    nv = max(2, math.ceil((v1 - v0) / (sv or (v1 - v0) / 12)))
    positions = [surface.at(surface.u_period * i / nu, v0 + (v1 - v0) * j / nv) for i in range(nu + 1) for j in range(nv + 1)]  # fmt: skip
    triangles = []
    for i in range(nu):
        for j in range(nv):
            a, b = i * (nv + 1) + j, (i + 1) * (nv + 1) + j
            for t in ((a, b, b + 1), (a, b + 1, a + 1)):
                triangles.append(t if natural else (t[0], t[2], t[1]))
    return positions, triangles


def _banded(cell: list[Corner], bands: list[float]) -> list[list[Corner]]:
    """A cell cut by lines of constant v: the convex pieces between them."""
    vs = [corner[0][1] for corner in cell]
    lines = [b for b in bands if min(vs) < b < max(vs)]
    if not lines:
        return [cell]
    levels = [-math.inf, *lines, math.inf]
    pieces = []
    for lo, hi in pairwise(levels):
        piece = cell
        if lo != -math.inf:
            piece = _cut(piece, lo, True)
        if hi != math.inf and piece:
            piece = _cut(piece, hi, False)
        if len(piece) >= 3:
            pieces.append(piece)
    return pieces


def _cut(polygon: list[Corner], level: float, above: bool) -> list[Corner]:
    """The part of a convex polygon above (or below) v = level, with corners where it crosses: on a strip's edge,
    named by where, so the strip beside it shares them; on a boundary, named by the boundary."""
    out = []
    n = len(polygon)
    for i in range(n):
        p, q = polygon[i], polygon[(i + 1) % n]
        p_in = p[0][1] >= level if above else p[0][1] <= level
        q_in = q[0][1] >= level if above else q[0][1] <= level
        if p_in:
            out.append(p)
        if p_in != q_in:
            (pu, pv), (qu, qv) = p[0], q[0]
            u = pu + (qu - pu) * (level - pv) / (qv - pv)
            if pu == qu:
                out.append(((u, level), ("g", pu, level), None))
            else:
                owner = p[2] if p[2] == q[2] or q[2] is None else q[2] if p[2] is None else p[2]
                if isinstance(owner, str):
                    out.append(((u, level), ("bg", owner, u, level), owner))
                else:
                    out.append(((u, level), ("x", owner, level), owner))
    return out
