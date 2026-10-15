"""System models (Yorg's dev page, for admins): a test stand's feed system as a P&ID, simulated with FullFlow and
ThermoProp against a test's data, to tune the model (CdAs, line losses, ullage heat transfer, collapse factor) until
it matches what was measured.

The server keeps the models and runs them: each run is a separate process (runner.py), so a long simulation never
slows the site, one that runs too long is stopped, and one gone wrong is kept from taking the site down with it
(runs.py). A run is a FullFlow script, which script.py writes from the model (the Models page shows it); only that
process imports FullFlow, running it (network.py, with library.py and components.py, which the script imports as
yorg_models).
"""
