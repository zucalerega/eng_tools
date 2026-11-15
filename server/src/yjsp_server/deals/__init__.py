"""Deals: listings on eBay for what the team wants, found once a day and kept current, for the site's own page and each
program's bill of design.

The site's, not an app's: what the team wants comes from each app, which says it in the site's terms (`wants.Want`),
through a function `app.py` hands over, as the site imports no app: Buildflow's components not yet procured, Vault's
vendors' parts, Piper's parts that say their model. `ebay.py` asks eBay's Browse API, as eBay's terms have it (no
seller's data kept, and nothing shown that's more than six hours old); `rank.py` says how well a listing fits; Claude,
within half of the budgets Help's answers keep to, says whether it would do (`finder.py`); and `finder.py` keeps the
deals (`Deal`, `DealRun`), in a thread of its own.
"""
