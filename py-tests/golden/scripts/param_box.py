# --- params ---
width = 40  # [10, 100] Overall width in mm
depth = 25  # [10, 100] Overall depth in mm
height = 12  # [5, 50] Overall height in mm
# --- end params ---
from build123d import *

result = Box(width, depth, height)
print("param_box built")
