// Notebooks to start from, in the Python window's Examples folder: each works on the first test attached to it (Data,
// beside it) once its channels' names are the test's (a script names a channel in quotes: "PT-TANK"). Each loads its
// data in its first cell, so the cells after it can be changed and run again without loading it again.

export interface Example {
    id: string;
    name: string;
    folder: string;
    code: string;
    order: number; // in the list
}

const FOLDER = "Examples";

let made = 0;
const example = (id: string, name: string, code: string): Example => ({
    id: `example:${id}`,
    name,
    folder: FOLDER,
    code,
    order: made++,
});

export const EXAMPLES: Example[] = [
    example(
        "start",
        "Start here: plot a channel",
        `# %% [markdown]
# # Start here
# A notebook: each cell runs on its own, in the notebook's variables. Load the data once (the first cell), then change
# and run the cells after it as often as you like: **Shift+Enter** runs a cell and goes on to the next.
#
# Change \`"PT-TANK"\` to one of the test's channels: **Data**, beside the notebook, lists them, and a click puts one in.

# %% Load the data
print("This test has:", ", ".join(yorg.channels()))
pt = yorg.channel("PT-TANK")
print(pt)

# %% Its peak
peak = pt.values.argmax()
print(f"Peak {pt.values[peak]:.1f} {pt.unit} at {pt.t[peak]:.3f} s")

# %% Plotted
yorg.plot(pt)
`,
    ),
    example(
        "cda",
        "Injector CdA from pressure drop and flow",
        `# %% [markdown]
# An injector's CdA through a test, **mdot / sqrt(2 rho dP)**: from its manifold's pressure, what it flows into, and a
# flow meter, with the liquid's density from CoolProp.

# %% Load the data
manifold = yorg.channel("PT-MANIFOLD")
meter = yorg.channel("FM-OX")
t, (pressure, flow) = yorg.resample(manifold, meter)  # on one clock
pressure = yorg.si(pressure, manifold.unit)  # Pa, absolute
flow = yorg.si(flow, meter.unit)  # kg/s

# %% The liquid's density (CoolProp's first import takes a while: once)
from CoolProp.CoolProp import PropsSI

density = PropsSI("D", "T", 293.15, "P", 101325.0, "Water")  # kg/m³
# LOX instead: PropsSI("D", "T", 90, "P", 5e5, "Oxygen")

# %% CdA while it flows
downstream = yorg.ATMOSPHERE  # or a chamber's pressure, in Pa
flowing = flow > 0.2 * flow.max()
cda = yorg.cda(flow[flowing], pressure[flowing] - downstream, density)
print(f"CdA {cda.mean() * 1e6:.3f} mm² ({cda.mean() / 0.00064516:.5f} in²)")
print(f"Spread {cda.std() * 1e6:.3f} mm²")
yorg.plot(t[flowing], cda * 1e6, name="Injector CdA", unit="mm²")
`,
    ),
    example(
        "ullage",
        "Ullage gas left, from CoolProp",
        `# %% [markdown]
# The pressurant in a tank's ullage through a test, from its pressure and temperature: CoolProp's real-gas density
# times the ullage's volume.

# %% Load the data
pt = yorg.channel("PT-TANK")
tc = yorg.channel("TC-ULLAGE")
t, (pressure, temperature) = yorg.resample(pt, tc)

# %% The gas left
from CoolProp.CoolProp import PropsSI

ULLAGE = 0.005  # m³ of gas (5 L): your tank's
GAS = "Nitrogen"
density = PropsSI("D", "P", yorg.si(pressure, pt.unit), "T", yorg.si(temperature, tc.unit), GAS)
mass = density * ULLAGE
print(f"{GAS}: {mass[0]:.4f} kg at the start, {mass[-1]:.4f} kg at the end")
yorg.plot(t, mass, name="Ullage gas", unit="kg")
`,
    ),
    example(
        "spectrum",
        "Spectrum of a channel (matplotlib)",
        `# %% Load the data
import numpy as np

pt = yorg.channel("PT-CHAMBER")
rate = 1 / np.median(np.diff(pt.t))
print(f"{pt.name}: {len(pt)} samples, {rate:.0f} a second")

# %% A Welch power spectrum, drawn with matplotlib
import matplotlib.pyplot as plt
from scipy import signal

frequencies, power = signal.welch(pt.values - pt.values.mean(), fs=rate, nperseg=min(4096, len(pt)))
plt.semilogy(frequencies, power)
plt.xlabel("Frequency (Hz)")
plt.ylabel(f"Power ({pt.unit}²/Hz)")
plt.title(f"{pt.name}, {rate:.0f} samples a second")
plt.grid(True, alpha=0.3)
plt.show()
`,
    ),
    example(
        "rate",
        "Smoothed, and how fast it changes",
        `# %% Load the data
import numpy as np

pt = yorg.channel("PT-TANK")
dt = float(np.median(np.diff(pt.t)))

# %% Smoothed (Savitzky-Golay), and its rate of change: a tank pressurizing, a chamber's rise
from scipy.signal import savgol_filter

window = max(5, int(0.05 / dt) | 1)  # 50 ms: an odd number of samples
smooth = savgol_filter(pt.values, window, 3)
rate = savgol_filter(pt.values, window, 3, deriv=1, delta=dt)
yorg.plot(pt.t, pt.values, name=f"{pt.name}", unit=pt.unit, title="Smoothed")
yorg.plot(pt.t, smooth, name=f"{pt.name} smoothed", unit=pt.unit, title="Smoothed")
yorg.plot(pt.t, rate, name=f"{pt.name} rate", unit=f"{pt.unit}/s")
print(f"Fastest rise {rate.max():.1f} {pt.unit}/s at {pt.t[rate.argmax()]:.3f} s")
`,
    ),
    example(
        "summary",
        "Every channel, summed up (pandas, CSV)",
        `# %% Load every channel (a name made as the script runs loads with await)
channels = {}
for name in yorg.channels():
    channels[name] = await yorg.load(name)
print(f"{len(channels)} channels")

# %% A table of them, and a CSV of it to download
import numpy as np
import pandas as pd

rows = [
    {"channel": name, "unit": one.unit, "samples": len(one),
     "min": np.nanmin(one.values), "max": np.nanmax(one.values), "mean": np.nanmean(one.values)}
    for name, one in channels.items()
    if len(one)
]
table = pd.DataFrame(rows)
print(table.to_string(index=False))
yorg.download("channels.csv", table)
`,
    ),
    example(
        "compare",
        "One channel in two tests",
        `# %% Load both: the first test attached, and another named here
OTHER = "Hotfire 4"

here = yorg.channel("PT-CHAMBER")
there = await yorg.load(here.name, dataset=OTHER)

# %% One over the other, each from its T0 (or its start)
zero = yorg.t0 if yorg.t0 is not None else here.t[0]
yorg.plot(here.t - zero, here.values, name=yorg.dataset["name"], unit=here.unit, title=here.name)
yorg.plot(there.t - there.t[0], there.values, name=OTHER, unit=there.unit, title=here.name)
`,
    ),
    example(
        "package",
        "A package from PyPI (pint)",
        `# %% Pure-Python packages from PyPI install with micropip (Pyodide's pip): once while Python stays open
import micropip

await micropip.install("pint")

# %% Here, pint, for units
import pint

units = pint.UnitRegistry()
pressure = 300 * units.psi
print(pressure.to("bar"), "=", pressure.to("MPa"))
`,
    ),
];
