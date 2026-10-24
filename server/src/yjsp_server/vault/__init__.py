"""Vault: the team's CAD files (SolidWorks and STEP), with check-out/check-in, version history, and folder permissions.

It shares the server, the database, and sign-in with Yorg and Piper, and nothing else: `models.py` has its tables,
`vault.py` every operation (start there), `access.py` the folder tree and permissions, `paths.py` the rules for paths,
`storage.py` the file contents, and `api.py` its routes (/api/folders, /api/files, ...).
"""
