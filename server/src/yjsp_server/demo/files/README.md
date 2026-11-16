# The demo's CAD

The demo's only CAD files are SparkFun's model of the SM-S4303R continuous-rotation servo (product 9347), unchanged,
from [sparkfun/3D_Models](https://github.com/sparkfun/3D_Models/tree/master/products), © SparkFun Electronics, under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The demo's seed (`../seed.py`) checks them in as a
vendor's part, saying so, so Caliper's 3D view and an assembly's parts can be seen. They're copies of three of the
server's test files (`server/tests/fixtures/solidworks`), which their README describes.

- `Embout.SLDPRT`: the output spline.
- `Servomoteur.SLDPRT`: the servo's case.
- `9347.SLDASM`: the two together.
