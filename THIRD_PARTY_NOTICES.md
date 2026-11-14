# Third-Party Notices & Attributions

`WuWaViewer` is licensed under the **MIT License** (see [`LICENSE`](LICENSE)) unless otherwise noted below for third-party or adapted components.

---

## 1. CUE4Parse (Apache License 2.0)

- **Upstream**: [`FabianFG/CUE4Parse`](https://github.com/FabianFG/CUE4Parse) (tracked as a Git submodule at `CUE4Parse/`)
- **License**: Apache License, Version 2.0 — see [`CUE4Parse/LICENSE`](CUE4Parse/LICENSE)
- **Upstream Notices**: See [`CUE4Parse/NOTICE`](CUE4Parse/NOTICE) for all third-party libraries bundled or referenced by CUE4Parse.

### Modified Files in This Repository (`Apache-2.0`)

To target `.NET 9` (`net9.0`) without modifying the upstream `CUE4Parse` submodule working tree, the following files in `WuWaViewer.Net9/` are adapted from upstream CUE4Parse under the terms of the Apache License 2.0:

1. `WuWaViewer.Net9/cue/OodleHelperNet9.cs` — adapted from `CUE4Parse/Compression/OodleHelper.cs` (replaces .NET 10 `ZipArchive.CreateAsync` / `entry.OpenAsync` APIs with `.NET 9`-compatible equivalents).
2. `WuWaViewer.Net9/conv/MaterialParametersNet9.cs` — adapted from `CUE4Parse-Conversion/Materials/MaterialParameters.cs` (uses `Enumerable.Reverse(...)` explicitly to avoid overload ambiguity).
3. `WuWaViewer.Net9/cue/CUE4Parse.Net9.csproj` and `WuWaViewer.Net9/conv/CUE4Parse-Conversion.Net9.csproj` — project wrappers targeting `net9.0` over the `CUE4Parse` submodule sources.

---

## 2. Native Decompression & Animation Libraries (Not Redistributed)

Binary native libraries under `WuWaViewer.Server/native/` are intentionally excluded via `.gitignore` and are **not** redistributed inside this MIT repository:

- **Oodle Data Decompression (`oodle-data-shared.dll` / `liboodle-data-shared.so`)**:
  - Retrieved on demand at runtime by `OodleHelper.InitializeAsync(...)` from [`WorkingRobot/OodleUE`](https://github.com/WorkingRobot/OodleUE) releases.
  - Subject to the [Unreal Engine EULA](https://www.unrealengine.com/eula/unreal) per upstream `OodleUE` notices.
- **CUE4Parse-Natives (`CUE4Parse-Natives.dll` / ACL)**:
  - Source lives inside the submodule at `CUE4Parse/CUE4Parse-Natives` (with `nfrechette/acl`, MIT License).
  - Required for ACL-compressed Unreal animations; build with CMake from `CUE4Parse/CUE4Parse-Natives` or place prebuilt binaries in `WuWaViewer.Server/native/`.

---

## 3. External Game Keys & Shader References (Ignored)

- **`wuwa-keys` ([`yarik0chka/wuwa-keys`](https://github.com/yarik0chka/wuwa-keys))**: External AES decryption key list (cloned locally by users, ignored in `.gitignore`).
- **`ue5-wuwa-shader` ([`GachaWhisperer/ue5-wuwa-shader`](https://github.com/GachaWhisperer/ue5-wuwa-shader))**: Optional read-only shader reference for contributors (cloned locally under `ref/`, ignored in `.gitignore`).
