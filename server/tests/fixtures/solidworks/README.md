# SolidWorks test files

The server's tests read these SolidWorks 2015 files for their 3D view (`vault/solidworks.py`), and so do the web app's
(`web/tests/caliper.test.tsx`). They're SparkFun's model of the SM-S4303R continuous-rotation servo (product 9347),
unchanged, from
[sparkfun/3D_Models](https://github.com/sparkfun/3D_Models/tree/master/products/9347/source_solidworks), © SparkFun
Electronics, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):

- `Embout.SLDPRT`: the output spline, a part of two bodies.
- `Servomoteur.SLDPRT`: the servo's case, a part whose faces have colors of their own.
- `9347.SLDASM`: the two together, the spline turned and moved onto the case.
