"""Write a fresh end-to-end-test/test.ipynb for the step-1 smoke test."""
import json
import pathlib

cells = [
    "x = 1\nx",
    "x += 1\nprint(x)",
    "import time\ntime.sleep(3)\n'slow done'",
    "import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.show()",
]
nb = {
    "cells": [
        {"cell_type": "code", "metadata": {}, "source": src, "outputs": [], "execution_count": None}
        for src in cells
    ],
    "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"}},
    "nbformat": 4,
    "nbformat_minor": 5,
}
path = pathlib.Path(__file__).with_name("test.ipynb")
path.write_text(json.dumps(nb, indent=1), encoding="utf-8")
print(path)
