Small hand-authored STEP fixtures for pure-stdlib verifier tiers.

- `valid_named_coloured.step`: two PRODUCT entities, `body` and `power_base`,
  with direct STYLED_ITEM links to stainless and matte black RGB values.
- `missing_product.step`: only the `body` PRODUCT, used to prove structural
  missing-component failures are measured from the STEP export.
- `broken.step`: truncated file without a valid ISO footer.
