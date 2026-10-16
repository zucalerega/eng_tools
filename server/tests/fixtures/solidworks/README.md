# SolidWorks test files

The server's tests read these SolidWorks files for their 3D view (`vault/solidworks.py`), and so do the web app's
(`web/tests/caliper.test.tsx`). They're SparkFun's, unchanged, from
[sparkfun/3D_Models](https://github.com/sparkfun/3D_Models/tree/master/products), © SparkFun Electronics, under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Their model of the SM-S4303R continuous-rotation servo (product 9347), saved by SolidWorks 2015:

- `Embout.SLDPRT`: the output spline, a part of two bodies.
- `Servomoteur.SLDPRT`: the servo's case, a part whose faces have colors of their own.
- `9347.SLDASM`: the two together, the spline turned and moved onto the case.

A box and its lid (product 11351), saved by SolidWorks 2014 or older, as an OLE compound file:

- `11351_body.SLDPRT` and `11351_lid.SLDPRT`.
- `11351_assembly.SLDASM`: the two together, the box where it was drawn and the lid turned over onto it.
