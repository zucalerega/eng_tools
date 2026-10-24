"""Piper: the team's fluid systems (P&IDs of the test stands, the vehicle's feed system, the GSE), drawn and kept with
their history.

It shares the server, the database, and sign-in with Vault and Yorg, and nothing else: `models.py` has its tables,
`diagrams.py` its rules, `schemas.py` the shape of a drawing and its API's bodies, and `api.py` its routes (/api/piper).
"""
