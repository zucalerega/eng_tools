// Scripts to start from, in the Python window's Examples folder: each works on the test picked above it once its
// channel names are the test's (a script names a channel in quotes: "PT-TANK").

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
        `# A channel of the test picked above: plotted, and its peak.
# Change "PT-TANK" to one of the test's channels (yorg.channels() lists them).

print("This test has:", ", ".join(yorg.channels()))

pt = yorg.channel("PT-TANK")
print(pt)
peak = pt.values.argmax()
print(f"Peak {pt.values[peak]:.1f} {pt.unit} at {pt.t[peak]:.3f} s")

yorg.plot(pt)
`,
    ),
    example(
        "cda",
        "Injector CdA from pressure drop and flow",
        `# An injector's CdA through a test, mdot / sqrt(2 rho dP): from its manifold's pressure,
# what it flows into, and a flow meter, with the liquid's density from CoolProp.
from CoolProp.CoolProp import PropsSI

manifold = yorg.channel("PT-MANIFOLD")
meter = yorg.channel("FM-OX")
t, (pressure, flow) = yorg.resample(manifold, meter)  # on one clock
pressure = yorg.si(pressure, manifold.unit)  # Pa, absolute
flow = yorg.si(flow, meter.unit)  # kg/s
downstream = yorg.ATMOSPHERE  # or a chamber's pressure, in Pa
density = PropsSI("D", "T", 293.15, "P", 101325.0, "Water")  # kg/m³
# LOX instead: PropsSI("D", "T", 90, "P", 5e5, "Oxygen")

flowing = flow > 0.2 * flow.max()  # only while it flows
cda = yorg.cda(flow[flowing], pressure[flowing] - downstream, density)
print(f"CdA {cda.mean() * 1e6:.3f} mm² ({cda.mean() / 0.00064516:.5f} in²)")
print(f"Spread {cda.std() * 1e6:.3f} mm²")
yorg.plot(t[flowing], cda * 1e6, name="Injector CdA", unit="mm²")
`,
    ),
    example(
        "ullage",
        "Ullage gas left, from CoolProp",
        `# The pressurant in a tank's ullage through a test, from its pressure and temperature:
# CoolProp's real-gas density times the ullage's volume.
from CoolProp.CoolProp import PropsSI

ULLAGE = 0.005  # m³ of gas (5 L): your tank's
GAS = "Nitrogen"

pt = yorg.channel("PT-TANK")
tc = yorg.channel("TC-ULLAGE")
t, (pressure, temperature) = yorg.resample(pt, tc)
density = PropsSI("D", "P", yorg.si(pressure, pt.unit), "T", yorg.si(temperature, tc.unit), GAS)
mass = density * ULLAGE
print(f"{GAS}: {mass[0]:.4f} kg at the start, {mass[-1]:.4f} kg at the end")
yorg.plot(t, mass, name="Ullage gas", unit="kg")
`,
    ),
    example(
        "spectrum",
        "Spectrum of a channel (matplotlib)",
        `# How a channel's signal spreads over frequencies: a Welch power spectrum, drawn with matplotlib.
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal

pt = yorg.channel("PT-CHAMBER")
rate = 1 / np.median(np.diff(pt.t))
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
        `# A channel smoothed (Savitzky-Golay), and its rate of change: a tank pressurizing, a chamber's rise.
import numpy as np
from scipy.signal import savgol_filter

pt = yorg.channel("PT-TANK")
dt = float(np.median(np.diff(pt.t)))
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
        `# Each channel of the test: its samples, range, and mean, as a table; then a CSV of it to download.
import numpy as np
import pandas as pd

rows = []
for name in yorg.channels():
    channel = await yorg.load(name)  # a name made as the script runs: loaded with await
    if len(channel):
        values = channel.values
        rows.append(
            {"channel": name, "unit": channel.unit, "samples": len(channel),
             "min": np.nanmin(values), "max": np.nanmax(values), "mean": np.nanmean(values)}
        )
table = pd.DataFrame(rows)
print(table.to_string(index=False))
yorg.download("channels.csv", table)
`,
    ),
    example(
        "compare",
        "One channel in two tests",
        `# The same channel in two tests, one over the other, each from its T0 (or its start): the test picked above, and
# another named here.
OTHER = "Hotfire 4"

here = yorg.channel("PT-CHAMBER")
there = await yorg.load(here.name, dataset=OTHER)
zero = yorg.t0 if yorg.t0 is not None else here.t[0]
yorg.plot(here.t - zero, here.values, name=yorg.dataset["name"], unit=here.unit, title=here.name)
yorg.plot(there.t - there.t[0], there.values, name=OTHER, unit=there.unit, title=here.name)
`,
    ),
    example(
        "package",
        "A package from PyPI (pint)",
        `# Pure-Python packages from PyPI install with micropip (Pyodide's pip): here, pint, for units.
import micropip

await micropip.install("pint")
import pint

units = pint.UnitRegistry()
pressure = 300 * units.psi
print(pressure.to("bar"), "=", pressure.to("MPa"))
`,
    ),
];
