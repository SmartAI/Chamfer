from build123d import *

base = Box(30, 30, 6)
base.label = "base"
pin = Pos(50, 0, 0) * Cylinder(4, 20)
pin.label = "pin"
result = Compound(children=[base, pin])
