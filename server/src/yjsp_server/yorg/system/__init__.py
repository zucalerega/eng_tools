"""System models (Yorg's dev page, for admins): a test stand's feed system as a P&ID, simulated with FullFlow and
ThermoProp against a test's data, to tune the model (CdAs, line losses, ullage heat transfer, collapse factor) until
it matches what was measured.

The server keeps the models and runs them: each run is a separate process (runner.py), so a long simulation never
slows the site, and one that runs too long is stopped. Only that process imports FullFlow (network.py,
components.py).
"""
