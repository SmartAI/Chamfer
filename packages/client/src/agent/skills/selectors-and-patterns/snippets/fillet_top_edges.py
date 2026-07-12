from build123d import Axis, Box, fillet


body = Box(40.0, 30.0, 10.0)
top_edges = body.faces().sort_by(Axis.Z)[-1].edges()
assert len(top_edges) == 4
result = fillet(top_edges, radius=3.0)

# Four new cylindrical blend faces; the bottom stays sharp.
assert len(result.faces()) > len(body.faces())
assert result.volume < body.volume
