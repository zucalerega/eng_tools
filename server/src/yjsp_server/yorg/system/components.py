"""What a Yorg model needs of its own besides FullFlow's components (which model all its physics): a Sensor that
anchors a knob to a test's channel, and a component that collects the run's outputs. They follow FullFlow's recipe for
custom components: constructor arguments become states in setup(), and evaluate_states() computes.
"""

import math

import numpy as np
from fullflow import Component, Sensor


class Anchor(Sensor):
    """FullFlow's Sensor anchoring a knob to a channel, reading the channel as a straight line between its samples
    (times, values) rather than holding the last one, over [start, end]; and off for a step shorter than shortest, and
    for the rest of a step it failed in.

    FullFlow lands a step on each change of a valve's command, and retries a hard one in halves, so some steps are a
    sliver of the rest: anchored over one, a knob that acts through what a tank holds would make up a whole step's
    difference from the data at once, far past anything real. Off, FullFlow holds the knob where it was.

    Where no value of the knob matches the channel in a step (a valve's CdA while it's shut; a line's flow that its
    inertia keeps from jumping to the test's), FullFlow's solve of the step fails, after SciPy has tried all it may, and
    FullFlow retries it in halves. The anchor is off for those, up to the end of the step it failed: anchored for them
    too, each would fail as long again, before one short enough to be off."""

    def __init__(self, name, network, reading, variable, data, times, values, start, end, shortest):
        super().__init__(name, network, reading=reading, variable=variable, data=data)
        self._times, self._values = times, values
        self._span, self._shortest = (start, end), shortest
        self._solved = (math.nan, math.nan)  # the step solved last: its time, and the target it was solved to
        self._tried = (math.nan, math.nan)  # the step tried first from the last time reached: where from, and to
        self._failed = -math.inf  # the end of a step the anchor failed in, up to which it's off

    def target_value(self, time_value=None):
        t = float(self.network.time.value if time_value is None else time_value)
        try:
            previous = float(self.network.time.previous)
        except ValueError:  # no step taken yet: the run's start, which nothing is solved at
            return math.nan
        if t == previous:  # the step to t is done, and read for its results: as it was solved
            return self._solved[1] if self._solved[0] == t else math.nan
        if previous != self._tried[0]:
            self._tried = (previous, t)
        elif t < self._tried[1] and math.isfinite(self._solved[1]):  # FullFlow retrying a step it was anchored in
            self._failed = max(self._failed, self._tried[1])
        if t <= self._failed or t - previous < self._shortest or not self._span[0] <= t <= self._span[1]:
            target = math.nan
        else:
            target = float(np.interp(t, self._times, self._values))
        self._solved = (t, target)
        return target


class Recorder(Component):
    """Reports the values a run's results need (nodes' pressures, edges' flows), each under a name of its own
    (part.output), so they can be read back by part and output; and tells how far the run has got.

    One component for them all: FullFlow evaluates every component many times in each time step, so a component for
    each value would cost more than some of the physics.
    """

    def __init__(self, name, network):
        self._readings = {}
        self._progress = None
        self.setup()

    def add(self, key, state) -> None:
        self._readings[key] = state

    def on_progress(self, progress) -> None:
        self._progress = progress

    @property
    def export_attributes(self):
        return self._readings

    def evaluate_states(self):
        if self._progress is not None:
            self._progress(float(self.network.time.value))
