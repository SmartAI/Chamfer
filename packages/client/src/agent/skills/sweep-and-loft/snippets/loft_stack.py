from build123d import Circle, Plane, Rectangle, loft


sections = [
    Plane.XY * Rectangle(40.0, 40.0),
    Plane.XY.offset(25.0) * Rectangle(30.0, 30.0),
    Plane.XY.offset(50.0) * Circle(10.0),
]
result = loft(sections)
