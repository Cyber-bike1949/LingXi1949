#!/usr/bin/env python3
"""Validate the in-repository Core package wiring."""
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2]
for product in [root / 'obsidian-plugin', root / 'remote']:
    if not product.is_dir():
        raise SystemExit(f'Missing product package: {product}')
    if (product / 'vendor' / 'lingxi-core').exists():
        raise SystemExit(f'Legacy vendor snapshot still exists: {product}')
print('Core is consumed directly from packages/core')
