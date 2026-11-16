# Third-party notices

YJSP's own code is under the licenses in [README.md](README.md#license): `server/` and `web/` under the GNU GPL,
version 3 ([LICENSE](LICENSE)), and `client/` under the MIT license ([client/LICENSE](client/LICENSE)). It uses, and
in places carries, others' work under their own terms. Every dependency is pinned in a lockfile (`server/uv.lock`,
`web/package-lock.json`, `client/**/packages.lock.json`), whose packages' own metadata have the rest; these are the
ones whose terms ask for more than a permissive license does, or that the repository or a download carries.

## Why the server is GPL

Yorg's system models (`server/src/yjsp_server/yorg/system/`, which Piper's Simulation mode runs) are built on
[FullFlow](https://github.com/saakethramoju/FullFlow), fullplot, and
[ThermoProp](https://github.com/saakethramoju/ThermoProp), by Saaketh Ramoju, under the GPL, version 3 only, and through
them on [PYroMat](https://pypi.org/project/PYroMat/) and [rocketprops](https://pypi.org/project/rocketprops/), under the
GPL, version 3. `fullflow[thermo]` is one of the server's dependencies, and its modules subclass FullFlow's, so the
server, as it's distributed (the Docker image, or the repository with its dependencies), is a GPL work.

## In the repository

- `server/tests/fixtures/solidworks/`: SparkFun Electronics' models of a servo and a box, from
  [sparkfun/3D_Models](https://github.com/sparkfun/3D_Models), unchanged, © SparkFun Electronics, under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (that folder's README says which is which).
- `web/tests/fixtures/tab.step`: a plate made for the tests with build123d.

## In the web app

- [occt-import-js](https://github.com/kovacsv/occt-import-js), which reads STEP and IGES files in the browser (Vault's
  Caliper): Open CASCADE Technology, compiled to WebAssembly, under the GNU LGPL, version 2.1. The build serves it as
  files of its own (`occt-import-js-*.js` and `.wasm` in `web/dist/assets`), which can be replaced with another build of
  it; its source is at that address.
- [Pyodide](https://pyodide.org), which runs Yorg's Python scripts in the browser, is loaded from jsDelivr when a script
  runs, not carried: Mozilla Public License 2.0, with the packages it loads under their own.
- The rest of the web app's dependencies (React, three.js, CodeMirror) are under the MIT license.

## In the SolidWorks add-in's installer

- Dassault Systèmes' SolidWorks API interop assemblies (`SolidWorks.Interop.*.dll`), from the
  `Visiativ.SOLIDWORKS.Interop` package on NuGet, which states no license of its own. The add-in references them, and its
  build copies them into its folder, which `Vault-Setup.exe` carries. They're Dassault's, under its terms for the
  SolidWorks API; building the add-in to embed their types instead (`EmbedInteropTypes`) would leave them out.
- The rest of the client's dependencies (`System.Text.Json`, `System.Security.Cryptography.ProtectedData`) are
  Microsoft's, under the MIT license.

## Names

SolidWorks is a trademark of Dassault Systèmes; Visio of Microsoft; Kenesto of Kenesto Corporation; eBay of eBay Inc.
They're named only to say what this works with.
