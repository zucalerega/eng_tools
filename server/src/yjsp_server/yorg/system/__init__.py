"""System models (for admins, while they're tried out): a test stand's feed system, as Piper's Simulation mode builds it
from a P&ID, simulated with FullFlow and ThermoProp against a test's data, to tune the model (CdAs, line losses, ullage
heat transfer, collapse factor) until it matches what was measured.

The server runs models; Piper keeps them, in its diagrams' drawings. Each run is a separate process (runner.py), so a
long simulation never slows the site, one that runs too long is stopped, and one gone wrong is kept from taking the site
down with it (runs.py). A run is a FullFlow script, which script.py writes from the model (Piper shows it); only that
process imports FullFlow, running it (network.py, with library.py and components.py, which the script imports as
yorg_models).
"""
