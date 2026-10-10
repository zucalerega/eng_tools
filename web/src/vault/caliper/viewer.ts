import {
    AlwaysStencilFunc,
    AmbientLight,
    AxesHelper,
    BackSide,
    Box3,
    BufferAttribute,
    BufferGeometry,
    Color,
    DecrementWrapStencilOp,
    DirectionalLight,
    DoubleSide,
    FrontSide,
    Group,
    IncrementWrapStencilOp,
    LineBasicMaterial,
    LineLoop,
    LineSegments,
    type Material,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    MeshPhongMaterial,
    NotEqualStencilFunc,
    type Object3D,
    OrthographicCamera,
    PerspectiveCamera,
    Plane,
    PlaneGeometry,
    Points,
    PointsMaterial,
    Quaternion,
    Raycaster,
    ReplaceStencilOp,
    Scene,
    Sphere,
    SRGBColorSpace,
    Vector2,
    Vector3,
    WebGLRenderer,
} from "three";
import type { RGB } from "./format";
import {
    analyzeEdge,
    analyzeFace,
    bodyEdges,
    faceOf,
    faceTriangles,
    pointAt,
    transformDirection,
    transformPoint,
    type BodyEdges,
    type EdgeGeometry,
    type FaceGeometry,
    type Vec3,
} from "./geometry";
import type { Entity } from "./measure";
import { walk, type Body, type Model, type Node } from "./model";

// Caliper's 3D view, in WebGL (three.js), apart from the page's React: the model's parts where they go, their edges,
// a way around them like a CAD program's (drag to turn about the point under the mouse, wheel to zoom where it points,
// right-drag or shift-drag to pan), the axes, section planes that cut the model and fill the cuts, and picking faces,
// edges, and points to measure. It draws only when something changes.

export type View = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";

/** A section plane across one axis, at offset (mm). It cuts away the side past it, or flipped, the side before. */
export interface Section {
    axis: 0 | 1 | 2;
    offset: number;
    flipped: boolean;
}

/** Something picked to measure, and how the view shows it while it's picked. */
export interface Pick {
    node: string;
    entity: Entity;
    mark: Object3D;
}

export interface ViewerEvents {
    select(node: string | null): void; // a click on a part, when not measuring
    hover(entity: Entity | null): void; // what's under the mouse, when measuring
    pick(pick: Pick): void; // a click, when measuring
}

// SolidWorks' standard views: where the camera is (toward the model's origin), and which way is up.
const VIEWS: Record<View, [Vec3, Vec3]> = {
    front: [
        [0, 0, 1],
        [0, 1, 0],
    ],
    back: [
        [0, 0, -1],
        [0, 1, 0],
    ],
    right: [
        [1, 0, 0],
        [0, 1, 0],
    ],
    left: [
        [-1, 0, 0],
        [0, 1, 0],
    ],
    top: [
        [0, 1, 0],
        [0, 0, -1],
    ],
    bottom: [
        [0, -1, 0],
        [0, 0, 1],
    ],
    iso: [
        [1, 1, 1],
        [0, 1, 0],
    ],
};

const FOV = 30; // degrees, top to bottom, in perspective
const EDGE_COLOR = 0x1b222c;
const HOVER_COLOR = 0x3d8bfd;
const PICK_COLOR = 0xe0a500;
const SELECT_EMISSIVE = 0x1d4d94;
const CAP_COLOR = 0xb0533a; // where a section cuts the solid
const PIXELS_TO_EDGE = 7; // how near the mouse an edge is picked instead of the face
const PIXELS_TO_POINT = 9;

const linear = (rgb: RGB) => new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);

/** A body, ready to draw: its triangles and edges, and what's been worked out about its faces and edges. */
interface Prepared {
    body: Body;
    geometry: BufferGeometry;
    lines: BufferGeometry;
    edges: BodyEdges;
    starts: Uint32Array; // each face's first triangle
    edgesOf: number[][]; // the edges around each face
    faces: Map<number, FaceGeometry>;
    curves: Map<number, EdgeGeometry>;
}

/** A node that draws something: its bodies where the node puts them. */
interface Instance {
    node: Node;
    matrix: Matrix4;
    bodies: Prepared[];
    meshes: Mesh[];
    lines: LineSegments[];
}

interface Hit {
    instance: Instance;
    prepared: Prepared;
    face: number;
    point: Vector3;
}

export class Viewer {
    private readonly renderer: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly ortho = new OrthographicCamera();
    private readonly persp = new PerspectiveCamera(FOV);
    private readonly root = new Group(); // the model
    private readonly sections = new Group(); // the planes' fills, and the passes that find them
    private readonly marks = new Group(); // what's picked or under the mouse
    private readonly origin = new AxesHelper(1);
    private readonly prepared = new Map<string, Prepared[]>();
    private readonly materials = new Map<string, MeshPhongMaterial>();
    private readonly edgeMaterial = new LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.75 });
    private instances: Instance[] = [];
    private shown = new Set<string>();
    private selected = new Set<string>();
    private planes: Plane[] = [];
    private outlines: LineLoop[] = [];
    private hoverMark: Object3D | null = null;
    private picked: Pick[] = [];
    private annotation: { line: LineSegments; label: HTMLDivElement; at: Vector3 } | null = null;
    private measuring = false;
    private perspective = false;
    private edgesOn = true;

    // The view: what the camera looks at, which way it faces, and half the height it shows there (mm).
    private target = new Vector3();
    private rotation = new Quaternion();
    private halfHeight = 100;
    private center = new Vector3(); // the model's middle, and how far it reaches from it
    private radius = 100;
    private animation = 0;
    private frame = 0;
    // A standard view the model was shown in, until it's turned, panned, or zoomed by hand: kept whole as the view's
    // size changes (it's first shown before the page has its final size).
    private framed: View | null = null;

    private readonly canvas: HTMLCanvasElement;
    private readonly triad: SVGSVGElement;
    private readonly triadAxes: { group: SVGGElement; axis: Vector3 }[] = []; // X, Y, Z
    private readonly resize: ResizeObserver;
    private readonly cleanup: (() => void)[] = [];

    /** Throws if the browser can't draw in 3D (no WebGL). */
    constructor(
        private readonly container: HTMLElement,
        private readonly events: ViewerEvents,
    ) {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "caliper-canvas";
        this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, stencil: true });
        this.renderer.localClippingEnabled = true;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.append(this.canvas);
        this.scene.add(this.root, this.sections, this.marks, this.origin, this.persp, this.ortho);
        this.origin.visible = false;
        this.scene.add(new AmbientLight(0xffffff, 1.4));
        // A light where the camera is, a little above it, so the side you look at is lit however you turn.
        for (const camera of [this.persp, this.ortho]) {
            const light = new DirectionalLight(0xffffff, 1.9);
            light.position.set(-0.5, 1, 1);
            camera.add(light);
        }
        this.triad = this.makeTriad();
        this.resize = new ResizeObserver(() => this.fitCanvas());
        this.resize.observe(container);
        this.listen();
        this.fitCanvas();
    }

    dispose(): void {
        cancelAnimationFrame(this.frame);
        cancelAnimationFrame(this.animation);
        this.resize.disconnect();
        this.cleanup.forEach((undo) => undo());
        this.clearModel();
        this.edgeMaterial.dispose();
        this.renderer.dispose();
        this.canvas.remove();
        this.triad.remove();
        this.annotation?.label.remove();
    }

    // --- the model -----------------------------------------------------------------------------------------------

    setModel(model: Model): void {
        this.clearModel();
        for (const node of walk(model.nodes)) {
            if (!node.shape) {
                continue;
            }
            let bodies = this.prepared.get(node.shape.key);
            if (!bodies) {
                bodies = node.shape.bodies.map((body) => this.prepare(body));
                this.prepared.set(node.shape.key, bodies);
            }
            const matrix = new Matrix4().fromArray(node.matrix);
            const instance: Instance = { node, matrix, bodies, meshes: [], lines: [] };
            bodies.forEach((prepared, index) => {
                const mesh = new Mesh(prepared.geometry, this.material(node, prepared.body, false));
                const lines = new LineSegments(prepared.lines, this.edgeMaterial);
                for (const object of [mesh, lines]) {
                    object.matrixAutoUpdate = false;
                    object.matrix.copy(matrix);
                    object.userData = { instance, body: index };
                    object.renderOrder = 10;
                    this.root.add(object);
                }
                lines.visible = this.edgesOn;
                instance.meshes.push(mesh);
                instance.lines.push(lines);
            });
            this.instances.push(instance);
        }
        this.root.updateMatrixWorld(true);
        const box = this.boxOf(this.instances);
        const sphere = box.isEmpty() ? new Sphere(new Vector3(), 100) : box.getBoundingSphere(new Sphere());
        this.center.copy(sphere.center);
        this.radius = Math.max(sphere.radius, 1e-3);
        this.origin.scale.setScalar(this.radius * 0.25);
        this.shown = new Set(this.instances.map((instance) => instance.node.id));
        this.applyView("iso", false);
        this.buildSections();
    }

    /** The model's extent, for the section planes' sliders. */
    bounds(): { min: Vec3; max: Vec3 } {
        const box = this.boxOf(this.instances);
        return { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
    }

    setShown(shown: ReadonlySet<string>): void {
        this.shown = new Set(shown);
        for (const instance of this.instances) {
            const visible = shown.has(instance.node.id);
            instance.meshes.forEach((mesh) => (mesh.visible = visible));
            instance.lines.forEach((lines) => (lines.visible = visible && this.edgesOn));
        }
        if (this.planes.length > 0) {
            this.buildSections();
        }
        this.invalidate();
    }

    setSelected(selected: ReadonlySet<string>): void {
        this.selected = new Set(selected);
        for (const instance of this.instances) {
            const on = this.isSelected(instance.node.id);
            instance.meshes.forEach(
                (mesh, i) => (mesh.material = this.material(instance.node, instance.bodies[i]!.body, on)),
            );
        }
        this.invalidate();
    }

    setEdges(on: boolean): void {
        this.edgesOn = on;
        this.setShown(this.shown);
    }

    setOrigin(on: boolean): void {
        this.origin.visible = on;
        this.invalidate();
    }

    setPerspective(on: boolean): void {
        this.perspective = on;
        this.invalidate();
    }

    setMeasuring(on: boolean): void {
        this.measuring = on;
        this.canvas.classList.toggle("caliper-measuring", on);
        this.setHover(null);
    }

    // A node counts as selected when it, or an assembly it's in, is.
    private isSelected(id: string): boolean {
        for (const selected of this.selected) {
            if (id === selected || id.startsWith(`${selected}/`)) {
                return true;
            }
        }
        return false;
    }

    private clearModel(): void {
        this.root.clear();
        this.instances = [];
        for (const bodies of this.prepared.values()) {
            for (const prepared of bodies) {
                prepared.geometry.dispose();
                prepared.lines.dispose();
            }
        }
        this.prepared.clear();
        this.materials.forEach((material) => material.dispose());
        this.materials.clear();
        this.clearSections();
        this.setPicked([]);
        this.setHover(null);
        this.setAnnotation(null);
    }

    private prepare(body: Body): Prepared {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(body.positions, 3));
        geometry.setIndex(new BufferAttribute(body.indices, 1));
        geometry.computeVertexNormals(); // faces don't share vertices, so each is smooth on its own
        if (body.faces.some((face) => face.color)) {
            const colors = new Float32Array(body.positions.length);
            for (const face of body.faces) {
                const color = linear(face.color ?? body.color);
                for (let t = face.first; t < face.first + face.count; t++) {
                    for (let k = 0; k < 3; k++) {
                        colors.set([color.r, color.g, color.b], 3 * body.indices[3 * t + k]!);
                    }
                }
            }
            geometry.setAttribute("color", new BufferAttribute(colors, 3));
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const edges = bodyEdges(body);
        const lines = new BufferGeometry();
        lines.setAttribute("position", new BufferAttribute(edges.segments, 3));
        lines.computeBoundingSphere();
        const edgesOf: number[][] = body.faces.map(() => []);
        edges.edges.forEach((edge, e) => edge.faces.forEach((f) => edgesOf[f]?.push(e)));
        return {
            body,
            geometry,
            lines,
            edges,
            starts: Uint32Array.from(body.faces, (face) => face.first),
            edgesOf,
            faces: new Map(),
            curves: new Map(),
        };
    }

    // One material per look, shared by every body that has it.
    private material(node: Node, body: Body, selected: boolean): MeshPhongMaterial {
        const own = node.color;
        const perFace = !own && body.faces.some((face) => face.color);
        const color = own ?? body.color;
        const opacity = node.opacity ?? body.opacity;
        const key = `${perFace ? "faces" : color.join(",")}|${opacity}|${selected}`;
        let material = this.materials.get(key);
        if (!material) {
            material = new MeshPhongMaterial({
                color: perFace ? 0xffffff : linear(color),
                vertexColors: perFace,
                transparent: opacity < 1,
                opacity,
                depthWrite: opacity >= 1,
                side: DoubleSide,
                shininess: 30,
                specular: 0x1a1a1a,
                emissive: selected ? SELECT_EMISSIVE : 0x000000,
                // Behind its edges, so they're drawn on it.
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
                clippingPlanes: this.planes,
                clipIntersection: true,
            });
            this.materials.set(key, material);
        }
        return material;
    }

    private boxOf(instances: Instance[]): Box3 {
        const box = new Box3();
        for (const instance of instances) {
            for (const prepared of instance.bodies) {
                if (prepared.geometry.boundingBox) {
                    box.union(prepared.geometry.boundingBox.clone().applyMatrix4(instance.matrix));
                }
            }
        }
        return box;
    }

    // --- the view ------------------------------------------------------------------------------------------------

    private get camera(): PerspectiveCamera | OrthographicCamera {
        return this.perspective ? this.persp : this.ortho;
    }

    private fitCanvas(): void {
        const { clientWidth: width, clientHeight: height } = this.container;
        if (width > 0 && height > 0) {
            this.renderer.setSize(width, height, false);
            if (this.framed) {
                this.applyView(this.framed, false);
            }
            this.invalidate();
        }
    }

    private placeCamera(): void {
        const { clientWidth: width, clientHeight: height } = this.canvas;
        const aspect = width > 0 && height > 0 ? width / height : 1;
        const forward = new Vector3(0, 0, -1).applyQuaternion(this.rotation);
        const reach = this.target.distanceTo(this.center) + this.radius; // how far the model goes from the target
        if (this.perspective) {
            const distance = this.halfHeight / Math.tan((FOV * Math.PI) / 360);
            this.persp.aspect = aspect;
            this.persp.near = Math.max(distance - 1.5 * reach, distance / 1000);
            this.persp.far = distance + 1.5 * reach;
            this.persp.position.copy(this.target).addScaledVector(forward, -distance);
        } else {
            const distance = 2 * reach + 1;
            Object.assign(this.ortho, {
                left: -this.halfHeight * aspect,
                right: this.halfHeight * aspect,
                top: this.halfHeight,
                bottom: -this.halfHeight,
                near: Math.max(distance - 1.5 * reach, 0.001),
                far: distance + 1.5 * reach,
                zoom: 1,
            });
            this.ortho.position.copy(this.target).addScaledVector(forward, -distance);
        }
        this.camera.quaternion.copy(this.rotation);
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld(true);
    }

    /** Zoom to show everything showing, or just these nodes. */
    fit(nodes?: ReadonlySet<string>): void {
        this.framed = null;
        const within = this.instances.filter((instance) =>
            nodes
                ? [...nodes].some((id) => instance.node.id === id || instance.node.id.startsWith(`${id}/`))
                : this.shown.has(instance.node.id),
        );
        const [target, halfHeight] = this.framing(within.length > 0 ? within : this.instances);
        this.animate(target, this.rotation.clone(), halfHeight);
    }

    private framing(instances: Instance[]): [Vector3, number] {
        const box = this.boxOf(instances);
        if (box.isEmpty()) {
            return [this.center.clone(), this.radius * 1.1];
        }
        const sphere = box.getBoundingSphere(new Sphere());
        const { clientWidth: width, clientHeight: height } = this.canvas;
        const aspect = width > 0 && height > 0 ? width / height : 1;
        return [sphere.center, Math.max(sphere.radius, 1e-3) * 1.1 * Math.max(1, 1 / aspect)];
    }

    /** Look at the model from one of the standard directions, zoomed to show it all. */
    view(view: View, animated = true): void {
        this.applyView(view, animated);
    }

    private applyView(view: View, animated: boolean): void {
        this.framed = view;
        const [eye, up] = VIEWS[view];
        const rotation = new Quaternion().setFromRotationMatrix(
            new Matrix4().lookAt(new Vector3(...eye), new Vector3(), new Vector3(...up)),
        );
        const visible = this.instances.filter((instance) => this.shown.has(instance.node.id));
        const [target, halfHeight] = this.framing(visible.length > 0 ? visible : this.instances);
        if (animated) {
            this.animate(target, rotation, halfHeight);
        } else {
            [this.target, this.rotation, this.halfHeight] = [target, rotation, halfHeight];
            this.invalidate();
        }
    }

    private animate(target: Vector3, rotation: Quaternion, halfHeight: number): void {
        cancelAnimationFrame(this.animation);
        const from = { target: this.target.clone(), rotation: this.rotation.clone(), halfHeight: this.halfHeight };
        const start = performance.now();
        const step = () => {
            const t = Math.min((performance.now() - start) / 300, 1);
            const s = t * t * (3 - 2 * t);
            this.target.lerpVectors(from.target, target, s);
            this.rotation.slerpQuaternions(from.rotation, rotation, s);
            this.halfHeight = from.halfHeight * (halfHeight / from.halfHeight) ** s;
            this.invalidate();
            if (t < 1) {
                this.animation = requestAnimationFrame(step);
            }
        };
        this.animation = requestAnimationFrame(step);
    }

    private rotate(dx: number, dy: number, pivot: Vector3): void {
        this.framed = null;
        const k = (1.5 * Math.PI) / Math.max(this.canvas.clientHeight, 300);
        const up = new Vector3(0, 1, 0).applyQuaternion(this.rotation);
        const right = new Vector3(1, 0, 0).applyQuaternion(this.rotation);
        const turn = new Quaternion()
            .setFromAxisAngle(up, -dx * k)
            .multiply(new Quaternion().setFromAxisAngle(right, -dy * k));
        this.target.sub(pivot).applyQuaternion(turn).add(pivot);
        this.rotation.premultiply(turn).normalize();
        this.invalidate();
    }

    private pan(dx: number, dy: number): void {
        this.framed = null;
        const perPixel = (2 * this.halfHeight) / Math.max(this.canvas.clientHeight, 1);
        const right = new Vector3(1, 0, 0).applyQuaternion(this.rotation);
        const up = new Vector3(0, 1, 0).applyQuaternion(this.rotation);
        this.target.addScaledVector(right, -dx * perPixel).addScaledVector(up, dy * perPixel);
        this.invalidate();
    }

    /** Zoom in (factor > 1) or out, keeping the point under the mouse where it is. */
    private zoom(factor: number, ndc: Vector2): void {
        this.framed = null;
        const next = Math.min(Math.max(this.halfHeight / factor, this.radius * 1e-5), this.radius * 100);
        const aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
        const right = new Vector3(1, 0, 0).applyQuaternion(this.rotation);
        const up = new Vector3(0, 1, 0).applyQuaternion(this.rotation);
        const shift = this.halfHeight - next;
        this.target.addScaledVector(right, ndc.x * aspect * shift).addScaledVector(up, ndc.y * shift);
        this.halfHeight = next;
        this.invalidate();
    }

    // --- drawing -------------------------------------------------------------------------------------------------

    invalidate(): void {
        if (this.frame === 0) {
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.render();
            });
        }
    }

    private render(): void {
        this.placeCamera();
        this.renderer.render(this.scene, this.camera);
        this.drawTriad();
        if (this.annotation) {
            this.placeLabel(this.annotation.label, this.annotation.at);
        }
    }

    /** Where a point of the model is on the page, in pixels from the view's top left; null if it's behind. */
    project(point: Vec3): { x: number; y: number } | null {
        const p = new Vector3(...point).project(this.camera);
        if (p.z > 1) {
            return null;
        }
        return {
            x: ((p.x + 1) / 2) * this.canvas.clientWidth,
            y: ((1 - p.y) / 2) * this.canvas.clientHeight,
        };
    }

    // The axes, in the corner: which way X, Y, and Z point. Click one to look along it.
    private makeTriad(): SVGSVGElement {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "caliper-triad");
        svg.setAttribute("viewBox", "-50 -50 100 100");
        svg.setAttribute("aria-hidden", "true");
        const axes: [string, string, View][] = [
            ["X", "#d1453b", "right"],
            ["Y", "#3c9a3c", "top"],
            ["Z", "#3c6fd1", "front"],
        ];
        for (const [name, color, view] of axes) {
            const group = document.createElementNS(ns, "g");
            group.dataset.axis = name;
            const line = document.createElementNS(ns, "line");
            line.setAttribute("stroke", color);
            line.setAttribute("stroke-width", "3");
            line.setAttribute("stroke-linecap", "round");
            const dot = document.createElementNS(ns, "circle");
            dot.setAttribute("r", "8");
            dot.setAttribute("fill", color);
            const label = document.createElementNS(ns, "text");
            label.textContent = name;
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("dominant-baseline", "central");
            group.append(line, dot, label);
            group.addEventListener("click", () => this.view(view));
            svg.append(group);
            this.triadAxes.push({
                group,
                axis: new Vector3(name === "X" ? 1 : 0, name === "Y" ? 1 : 0, name === "Z" ? 1 : 0),
            });
        }
        this.container.append(svg);
        return svg;
    }

    private drawTriad(): void {
        const inverse = this.rotation.clone().invert();
        const placed = this.triadAxes.map(({ group, axis: along }) => {
            const axis = along.clone().applyQuaternion(inverse); // where it points on the screen
            const [x, y] = [axis.x * 34, -axis.y * 34];
            const [line, dot, label] = group.children as unknown as [SVGLineElement, SVGCircleElement, SVGTextElement];
            line.setAttribute("x1", "0");
            line.setAttribute("y1", "0");
            line.setAttribute("x2", String(x));
            line.setAttribute("y2", String(y));
            dot.setAttribute("cx", String(x));
            dot.setAttribute("cy", String(y));
            label.setAttribute("x", String(x));
            label.setAttribute("y", String(y));
            group.style.opacity = axis.z < -0.2 ? "0.55" : "1";
            return { group, depth: axis.z };
        });
        // Nearer axes over farther ones.
        placed.sort((a, b) => a.depth - b.depth).forEach(({ group }) => this.triad.append(group));
    }

    // --- sections ------------------------------------------------------------------------------------------------

    /**
     * Cut the model with these planes. With more than one, what's cut away is what's past all of them: two make a
     * cutaway, as SolidWorks' section views do. Where a plane cuts a solid, it's filled in.
     */
    setSections(sections: Section[]): void {
        this.planes = sections.map((section) => {
            const normal = new Vector3();
            normal.setComponent(section.axis, section.flipped ? 1 : -1);
            return new Plane(normal, section.flipped ? -section.offset : section.offset);
        });
        const clip = (material: Material) => {
            material.clippingPlanes = this.planes;
            material.clipIntersection = true;
        };
        this.materials.forEach(clip);
        clip(this.edgeMaterial);
        this.marks.traverse((object) => {
            if (object instanceof Mesh) {
                clip(object.material as Material);
            }
        });
        this.buildSections();
        this.invalidate();
    }

    private clearSections(): void {
        this.sections.traverse((object) => {
            if (object instanceof Mesh || object instanceof LineLoop) {
                object.geometry.dispose();
                (object.material as MeshBasicMaterial).dispose();
            }
        });
        this.sections.clear();
        this.outlines = [];
    }

    // Filling a cut: the shown solids drawn into the stencil buffer only, back faces counting up and front faces down,
    // leave non-zero exactly where the plane is inside a solid; the plane is then drawn there. Once for each plane.
    private buildSections(): void {
        this.clearSections();
        if (this.planes.length === 0) {
            return;
        }
        const solids = this.mergedSolids();
        this.planes.forEach((plane, i) => {
            const others = this.planes.filter((other) => other !== plane);
            const pass = (
                side: typeof FrontSide | typeof BackSide,
                op: typeof IncrementWrapStencilOp | typeof DecrementWrapStencilOp,
            ) =>
                new MeshBasicMaterial({
                    side,
                    colorWrite: false,
                    depthWrite: false,
                    depthTest: false,
                    stencilWrite: true,
                    stencilFunc: AlwaysStencilFunc,
                    stencilFail: op,
                    stencilZFail: op,
                    stencilZPass: op,
                    clippingPlanes: [plane],
                });
            if (solids) {
                for (const [side, op] of [
                    [BackSide, IncrementWrapStencilOp],
                    [FrontSide, DecrementWrapStencilOp],
                ] as const) {
                    const mesh = new Mesh(solids, pass(side, op));
                    mesh.renderOrder = i + 1;
                    mesh.matrixAutoUpdate = false;
                    this.sections.add(mesh);
                }
            }
            // The fill, only where the other planes have cut too (where they're cut away, this plane is the surface).
            const fill = new Mesh(
                new PlaneGeometry(4 * this.radius, 4 * this.radius),
                new MeshPhongMaterial({
                    color: CAP_COLOR,
                    side: DoubleSide,
                    shininess: 10,
                    stencilWrite: true,
                    stencilRef: 0,
                    stencilFunc: NotEqualStencilFunc,
                    stencilFail: ReplaceStencilOp,
                    stencilZFail: ReplaceStencilOp,
                    stencilZPass: ReplaceStencilOp,
                    clippingPlanes: others.map((other) => other.clone().negate()),
                }),
            );
            fill.renderOrder = i + 1.1;
            const at = plane.projectPoint(this.center, new Vector3());
            fill.position.copy(at);
            fill.lookAt(at.clone().add(plane.normal));
            fill.onAfterRender = (renderer) => renderer.clearStencil();
            this.sections.add(fill);
            // Where the plane is: its outline around the model.
            const outline = new LineLoop(
                new BufferGeometry().setFromPoints(
                    [
                        [-1, -1],
                        [1, -1],
                        [1, 1],
                        [-1, 1],
                    ].map(([x, y]) => new Vector3(x! * this.radius * 1.2, y! * this.radius * 1.2, 0)),
                ),
                new LineBasicMaterial({ color: CAP_COLOR, transparent: true, opacity: 0.6 }),
            );
            outline.position.copy(at);
            outline.lookAt(at.clone().add(plane.normal));
            this.sections.add(outline);
            this.outlines.push(outline);
        });
    }

    // The shown solids as one mesh, in the model's coordinates: the stencil passes draw it in one go.
    private mergedSolids(): BufferGeometry | null {
        const parts: { positions: Float32Array; indices: Uint32Array; matrix: Matrix4 }[] = [];
        for (const instance of this.instances) {
            if (this.shown.has(instance.node.id)) {
                for (const prepared of instance.bodies) {
                    if (prepared.body.solid) {
                        const { positions, indices } = prepared.body;
                        parts.push({ positions, indices, matrix: instance.matrix });
                    }
                }
            }
        }
        if (parts.length === 0) {
            return null;
        }
        const positions = new Float32Array(parts.reduce((sum, part) => sum + part.positions.length, 0));
        const indices = new Uint32Array(parts.reduce((sum, part) => sum + part.indices.length, 0));
        const point = new Vector3();
        let [vertex, corner] = [0, 0];
        for (const part of parts) {
            for (let i = 0; i < part.positions.length; i += 3) {
                point
                    .fromArray(part.positions, i)
                    .applyMatrix4(part.matrix)
                    .toArray(positions, vertex * 3 + i);
            }
            for (let i = 0; i < part.indices.length; i++) {
                indices[corner + i] = part.indices[i]! + vertex;
            }
            vertex += part.positions.length / 3;
            corner += part.indices.length;
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        geometry.setIndex(new BufferAttribute(indices, 1));
        return geometry;
    }

    // --- picking and measuring -------------------------------------------------------------------------------------

    private hit(event: PointerEvent | MouseEvent): Hit | null {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(this.ndc(event), this.camera);
        const meshes = this.instances.filter((i) => this.shown.has(i.node.id)).flatMap((instance) => instance.meshes);
        for (const found of raycaster.intersectObjects(meshes, false)) {
            // What a section cut away isn't there to pick.
            if (this.planes.length > 0 && this.planes.every((plane) => plane.distanceToPoint(found.point) < 0)) {
                continue;
            }
            const { instance, body } = found.object.userData as { instance: Instance; body: number };
            const prepared = instance.bodies[body]!;
            return { instance, prepared, face: faceOf(prepared.starts, found.faceIndex ?? 0), point: found.point };
        }
        return null;
    }

    private ndc(event: PointerEvent | MouseEvent): Vector2 {
        const rect = this.canvas.getBoundingClientRect();
        return new Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
    }

    /** What's under the mouse to measure: a point at a corner, an edge near it, or else the face. */
    private under(event: PointerEvent | MouseEvent): { hit: Hit; edge: number | null; corner: Vec3 | null } | null {
        const hit = this.hit(event);
        if (!hit) {
            return null;
        }
        const rect = this.canvas.getBoundingClientRect();
        const mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const { instance, prepared } = hit;
        const screen = (p: Vec3) => this.project(transformPoint(instance.node.matrix, p));
        let best: { edge: number; distance: number } | null = null;
        for (const e of prepared.edgesOf[hit.face] ?? []) {
            const points = prepared.edges.edges[e]!.points;
            let previous = screen(pointAt(points, 0));
            for (let i = 1; i < points.length / 3; i++) {
                const next = screen(pointAt(points, i));
                if (previous && next) {
                    const distance = toSegment(mouse, previous, next);
                    if (distance < PIXELS_TO_EDGE && (!best || distance < best.distance)) {
                        best = { edge: e, distance };
                    }
                }
                previous = next;
            }
        }
        if (!best) {
            return { hit, edge: null, corner: null };
        }
        const edge = prepared.edges.edges[best.edge]!;
        if (!edge.closed) {
            for (const i of [0, edge.points.length / 3 - 1]) {
                const corner = transformPoint(instance.node.matrix, pointAt(edge.points, i));
                const on = this.project(corner);
                if (on && Math.hypot(on.x - mouse.x, on.y - mouse.y) < PIXELS_TO_POINT) {
                    return { hit, edge: best.edge, corner };
                }
            }
        }
        return { hit, edge: best.edge, corner: null };
    }

    /** What's under the mouse, as something to measure, and a mark for it. */
    private entityAt(event: PointerEvent | MouseEvent, color: number): Pick | null {
        const found = this.under(event);
        if (!found) {
            return null;
        }
        const { hit, edge, corner } = found;
        const { instance, prepared } = hit;
        const m = instance.node.matrix;
        if (corner) {
            return {
                node: instance.node.id,
                entity: { kind: "point", point: corner },
                mark: this.pointMark(corner, color),
            };
        }
        if (edge !== null) {
            const local = prepared.edges.edges[edge]!;
            const ownPoints = Array.from({ length: local.points.length / 3 }, (_, i) => pointAt(local.points, i));
            let geometry = prepared.curves.get(edge);
            if (!geometry) {
                geometry = analyzeEdge(ownPoints, local.closed);
                prepared.curves.set(edge, geometry);
            }
            const points = ownPoints.map((p) => transformPoint(m, p));
            return {
                node: instance.node.id,
                entity: { kind: "edge", edge: moveEdge(geometry, m), points },
                mark: this.lineMark(points, color),
            };
        }
        const face = prepared.body.faces[hit.face]!;
        let geometry = prepared.faces.get(hit.face);
        if (!geometry) {
            geometry = analyzeFace(prepared.body.positions, prepared.body.indices, face.first, face.count);
            prepared.faces.set(hit.face, geometry);
        }
        const points = faceTriangles(prepared.body.positions, prepared.body.indices, face.first, face.count).points;
        return {
            node: instance.node.id,
            entity: { kind: "face", face: moveFace(geometry, m), points: points.map((p) => transformPoint(m, p)) },
            mark: this.faceMark(instance, prepared, hit.face, color),
        };
    }

    private faceMark(instance: Instance, prepared: Prepared, face: number, color: number): Object3D {
        // Its own copy of the face's triangles: a mark is thrown away, and its part's arrays aren't.
        const { first, count } = prepared.body.faces[face]!;
        const positions = new Float32Array(9 * count);
        for (let corner = 0; corner < 3 * count; corner++) {
            positions.set(pointAt(prepared.body.positions, prepared.body.indices[3 * first + corner]!), 3 * corner);
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        const mesh = new Mesh(
            geometry,
            new MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.45,
                side: DoubleSide,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
                clippingPlanes: this.planes,
                clipIntersection: true,
            }),
        );
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(instance.matrix);
        mesh.renderOrder = 20;
        return mesh;
    }

    private lineMark(points: Vec3[], color: number): Object3D {
        const segments: number[] = [];
        for (let i = 0; i + 1 < points.length; i++) {
            segments.push(...points[i]!, ...points[i + 1]!);
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(new Float32Array(segments), 3));
        const lines = new LineSegments(geometry, new LineBasicMaterial({ color, depthTest: false }));
        lines.renderOrder = 21;
        return lines;
    }

    private pointMark(point: Vec3, color: number): Object3D {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(new Float32Array(point), 3));
        const points = new Points(
            geometry,
            new PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }),
        );
        points.renderOrder = 22;
        return points;
    }

    private setHover(pick: Pick | null): void {
        if (this.hoverMark) {
            this.marks.remove(this.hoverMark);
            disposeMark(this.hoverMark);
        }
        this.hoverMark = pick?.mark ?? null;
        if (this.hoverMark) {
            this.marks.add(this.hoverMark);
        }
        this.events.hover(pick?.entity ?? null);
        this.invalidate();
    }

    /** What's picked to measure, marked in the view. */
    setPicked(picks: Pick[]): void {
        for (const pick of this.picked) {
            if (!picks.includes(pick)) {
                this.marks.remove(pick.mark);
                disposeMark(pick.mark);
            }
        }
        for (const pick of picks) {
            if (!this.picked.includes(pick)) {
                this.marks.add(pick.mark);
            }
        }
        this.picked = [...picks];
        this.invalidate();
    }

    /** A measurement drawn in the view: a line from one point to another, labeled. */
    setAnnotation(annotation: { line: [Vec3, Vec3]; text: string } | null): void {
        if (this.annotation) {
            this.marks.remove(this.annotation.line);
            disposeMark(this.annotation.line);
            this.annotation.label.remove();
            this.annotation = null;
        }
        if (annotation) {
            const [from, to] = annotation.line;
            const line = this.lineMark([from, to], PICK_COLOR) as LineSegments;
            const label = document.createElement("div");
            label.className = "caliper-annotation";
            label.textContent = annotation.text;
            this.container.append(label);
            this.marks.add(line);
            this.annotation = { line, label, at: new Vector3(...from).lerp(new Vector3(...to), 0.5) };
        }
        this.invalidate();
    }

    private placeLabel(label: HTMLElement, at: Vector3): void {
        const on = this.project(at.toArray() as Vec3);
        label.style.display = on ? "" : "none";
        if (on) {
            label.style.transform = `translate(${on.x}px, ${on.y}px) translate(-50%, -130%)`;
        }
    }

    // --- the mouse -----------------------------------------------------------------------------------------------

    private listen(): void {
        const canvas = this.canvas;
        const down = new Map<number, { x: number; y: number }>();
        let dragging = false;
        let start = { x: 0, y: 0 };
        let pivot = new Vector3();
        let pinch = 0;
        let pending: PointerEvent | null = null;

        const on = <K extends keyof HTMLElementEventMap>(
            name: K,
            handler: (event: HTMLElementEventMap[K]) => void,
            options?: AddEventListenerOptions,
        ) => {
            canvas.addEventListener(name, handler, options);
            this.cleanup.push(() => canvas.removeEventListener(name, handler, options));
        };

        on("contextmenu", (event) => event.preventDefault());
        on("pointerdown", (event) => {
            canvas.setPointerCapture(event.pointerId);
            down.set(event.pointerId, { x: event.clientX, y: event.clientY });
            start = { x: event.clientX, y: event.clientY };
            dragging = false;
            if (down.size === 1) {
                pivot = this.hit(event)?.point ?? this.target.clone(); // turn about what's under the mouse
            }
        });
        on("pointermove", (event) => {
            const last = down.get(event.pointerId);
            if (!last) {
                // Hovering: what would be picked, once a frame at most.
                if (this.measuring) {
                    if (pending === null) {
                        requestAnimationFrame(() => {
                            const latest = pending;
                            pending = null;
                            if (latest) {
                                this.setHover(this.entityAt(latest, HOVER_COLOR));
                            }
                        });
                    }
                    pending = event;
                }
                return;
            }
            if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
                dragging = true;
                this.setHover(null);
            }
            if (!dragging) {
                return;
            }
            cancelAnimationFrame(this.animation);
            const [dx, dy] = [event.clientX - last.x, event.clientY - last.y];
            down.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (down.size === 2) {
                // Two fingers: pinch to zoom, move to pan.
                const [a, b] = [...down.values()] as [{ x: number; y: number }, { x: number; y: number }];
                const spread = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinch > 0) {
                    this.zoom(spread / pinch, new Vector2(0, 0));
                }
                pinch = spread;
                this.pan(dx / 2, dy / 2);
            } else if (event.buttons & 2 || event.buttons & 4 || event.shiftKey) {
                this.pan(dx, dy);
            } else {
                this.rotate(dx, dy, pivot);
            }
        });
        const up = (event: PointerEvent) => {
            const wasDown = down.delete(event.pointerId);
            pinch = 0;
            if (!wasDown || dragging || event.button !== 0) {
                return;
            }
            if (this.measuring) {
                const pick = this.entityAt(event, PICK_COLOR);
                if (pick) {
                    this.events.pick(pick);
                }
            } else {
                this.events.select(this.hit(event)?.instance.node.id ?? null);
            }
        };
        on("pointerup", up);
        on("pointercancel", (event) => (down.delete(event.pointerId), (pinch = 0)));
        on("pointerleave", () => {
            if (this.measuring && down.size === 0) {
                pending = null;
                this.setHover(null);
            }
        });
        on(
            "wheel",
            (event) => {
                event.preventDefault();
                cancelAnimationFrame(this.animation);
                const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
                this.zoom(Math.exp(-pixels * 0.0015), this.ndc(event));
            },
            { passive: false },
        );
        on("dblclick", (event) => {
            if (this.measuring) {
                return;
            }
            const hit = this.hit(event);
            this.fit(hit ? new Set([hit.instance.node.id]) : undefined);
        });
    }
}

/** How far a point is from a segment, all on the page. */
function toSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// A face's or edge's geometry, worked out where its part is, moved to where the node puts it.
function moveFace(face: FaceGeometry, m: number[]): FaceGeometry {
    switch (face.type) {
        case "plane":
            return { ...face, normal: transformDirection(m, face.normal), point: transformPoint(m, face.point) };
        case "cylinder":
            return { ...face, axis: transformDirection(m, face.axis), point: transformPoint(m, face.point) };
        case "cone":
            return { ...face, axis: transformDirection(m, face.axis), apex: transformPoint(m, face.apex) };
        case "sphere":
            return { ...face, center: transformPoint(m, face.center) };
        default:
            return face;
    }
}

function moveEdge(edge: EdgeGeometry, m: number[]): EdgeGeometry {
    switch (edge.type) {
        case "line":
            return { ...edge, start: transformPoint(m, edge.start), end: transformPoint(m, edge.end) };
        case "circle":
            return { ...edge, center: transformPoint(m, edge.center), axis: transformDirection(m, edge.axis) };
        default:
            return edge;
    }
}

function disposeMark(mark: Object3D): void {
    if (mark instanceof Mesh || mark instanceof LineSegments || mark instanceof Points) {
        mark.geometry.dispose();
        (mark.material as MeshBasicMaterial).dispose();
    }
}
