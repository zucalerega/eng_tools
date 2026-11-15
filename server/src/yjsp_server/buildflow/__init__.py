"""Buildflow: the team's programs (Hopper, Elytra, Felicette 2, HETS), each one's bill of design: its components, by
subsystem, drawn on the vehicle, and how far each has come through design, build, test, and launch.

It shares the server, the database, and sign-in with Vault, Yorg, and Piper, and nothing else: `models.py` has its
tables, `programs.py` the rules for a program's layout (admins'), `progress.py` the rules for its progress (anyone's),
`templates.py` what a new program starts from, `schemas.py` its API's bodies, and `api.py` its routes (/api/buildflow).
It links to the other apps' pages by their addresses, as anyone would, and imports none of their code.
"""
