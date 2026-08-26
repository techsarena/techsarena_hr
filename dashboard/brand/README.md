# Brand assets

`techsarena_hcm_logo.png` is the master mark (1024×1024). It is deliberately
**not** in `public/`, because nothing references it at full size and it would
add ~837KB to every deploy.

The sizes actually served are generated from it into `dashboard/public/`:

| File                   | Size | Used by                              |
|------------------------|------|--------------------------------------|
| `logo-128.png`         | 128  | sidebar mark, login card, desk navbar |
| `favicon-64.png`       | 64   | browser tab                          |
| `icon-192.png`         | 192  | PWA manifest                         |
| `icon-512.png`         | 512  | PWA manifest (any + maskable)        |
| `apple-touch-icon.png` | 180  | iOS home screen                      |

To regenerate after changing the master:

```sh
cd dashboard/brand
for spec in "512 icon-512" "192 icon-192" "180 apple-touch-icon" "128 logo-128" "64 favicon-64"; do
  set -- $spec
  sips -z "$1" "$1" techsarena_hcm_logo.png --out "../public/$2.png"
done
```

The brand colour `#3D44D2` is sampled from the mark's own background; it is set
in `dashboard/index.html` (`theme-color`) and `public/manifest.webmanifest`.
