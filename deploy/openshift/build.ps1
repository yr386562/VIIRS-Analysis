# Builds the viewer image in OpenShift from only the files it needs (the local cache folder holds gigabytes).
# Requires: oc, logged in to the cluster, in the project where build.yaml was applied.
$ErrorActionPreference = 'Stop'
$app = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('temper-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($item in 'Containerfile', 'requirements.txt', 'server.py', 'evt.py', 'bands.py', 'lightroast.py', 'rxmethod.py', 'vectors.py', 'static') {
        Copy-Item -Path (Join-Path $app $item) -Destination $stage -Recurse
    }
    oc start-build temper-viewer --from-dir=$stage --follow
} finally {
    Remove-Item -Recurse -Force -Confirm:$false $stage
}
