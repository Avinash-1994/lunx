# Lets `pytest trading-lab/tests` find the `lab` package from any working directory.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
