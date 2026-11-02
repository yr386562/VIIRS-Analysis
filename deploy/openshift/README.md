# TEMPER · LIGHT ROAST on OpenShift

The same viewer as on a desktop (see ../../README.md), as one pod behind an HTTPS route. Files: `Containerfile` and `requirements.txt` (in offline_viewer) and this folder:

| File | What it creates |
|---|---|
| `build.yaml` | ImageStream and BuildConfig: the image is built in the cluster from a local upload |
| `storage.yaml` | PVCs `temper-data` (500Gi, the country folders and LIGHT ROAST's under `_lightroast`, mounted read only) and `temper-cache` (150Gi) |
| `deployment.yaml` | One pod, port 8080, non-root (restricted-v2), health probes; rolls out on each new build |
| `service.yaml` | ClusterIP service on 8080 |
| `route.yaml` | HTTPS route (edge, HTTP redirects), 5 min timeout |
| `data-loader.yaml` | A temporary pod for copying the data into `temper-data` |

Steps, with `oc` logged in to the target project:

```powershell
cd offline_viewer\deploy\openshift   # this folder
oc apply -f storage.yaml -f build.yaml
.\build.ps1                                   # uploads only the app files, then builds; needs PyPI access from the cluster
oc apply -f data-loader.yaml
oc wait --for=condition=Ready pod/temper-data-loader
oc rsync "D:\VIIRS\VIIRS_NIGHT_SWIR/" temper-data-loader:/data --strategy=tar   # ~180 GB today, with M11/M15/M16
# LIGHT ROAST: only each country's raw_data (~70 GB), not _sources or _tiles
foreach ($c in 'Iran','Israel','Saudi Arabia','Yemen') { oc exec temper-data-loader -- mkdir -p "/data/_lightroast/$c"; oc rsync "D:\VIIRS\VIIRS_NIGHT_DNB\$c\raw_data" "temper-data-loader:/data/_lightroast/$c" --strategy=tar }
oc delete pod temper-data-loader
oc apply -f deployment.yaml -f service.yaml -f route.yaml
oc get route temper-viewer                    # the address to open
```

In the container the environment sets everything (see `deployment.yaml`):
- **Paths:** `TEMPER_DATA_ROOT=/data`, `TEMPER_LR_ROOT=/data/_lightroast` (no `raw_data` of its own, so the
  country picker skips it), `TEMPER_CACHE=/cache`.
- **Address:** `TEMPER_HOST=0.0.0.0`, `TEMPER_PORT=8080`.
- **Allowed hosts:** `TEMPER_ALLOWED_HOSTS=*`. That's fine behind the route; set the route host to pin it.
- **Hot-spot budget:** `TEMPER_HOT_BUDGET`.

When not bound to localhost, the folder-listing endpoint is off. Opening a country is limited to folders
under the data root.

Limits to know:
- **No login.** Anyone who can reach the route can use the viewer. Restrict it with the IP allowlist
  annotation in `route.yaml`, or put an OAuth proxy in front.
- **One shared country.** The open country is server-wide, so two people using it at the same time
  switch each other's country. That's why there is one replica.
- **Long first preparation.** The first preparation of each country takes several minutes in the background.
- **Data size.** Most of the 129 GB is the per-pass `provenance.npz` files, which hold more layers than
  the viewer reads. Slimming them to view zenith, native index and validity before upload would cut
  the data volume by most of that. `M11.tif`, `M15.tif` and `M16.tif` add ~33 MB per bundle (~48 GB today).
- **M11/M15/M16 have to be built before upload.** The cluster has no access to the granule archive, so run
  `python bands.py` locally first; the pod then reads the TIFFs from the data volume. Without them the viewer
  works with M10 only: no confirmation, source temperature, ground temperature or cloud flag.
- **Prepared-night cache.** A prepared night is 23–106 MB depending on the country, so a full year of three
  countries needs about 80 GB (`temper-cache` is 150Gi; `temper-data` 400Gi fits a full year).
