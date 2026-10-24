"""ROS 2 Launch file spawning N decentralized SwarmSync drone nodes + impairment relay + observer."""

from typing import List, Tuple


def generate_multi_drone_specs(fleet_size: int = 5) -> List[Tuple[str, int, float, float]]:
    import math
    specs: List[Tuple[str, int, float, float]] = []
    for i in range(1, fleet_size + 1):
        angle = (2.0 * math.pi * (i - 1)) / max(fleet_size, 1)
        x = round(500.0 + 120.0 * math.cos(angle), 2)
        y = round(500.0 + 120.0 * math.sin(angle), 2)
        specs.append((f"swarmsync_drone_{i}", i, x, y))
    return specs
