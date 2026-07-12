from build123d import Circle, Plane, ThreePointArc, sweep


path = ThreePointArc((-53.0, 0.0, 12.0), (0.0, 0.0, 27.0), (53.0, 0.0, 12.0))
profile = Plane(origin=path @ 0, z_dir=path % 0) * Circle(2.0)
result = sweep(profile, path=path)
