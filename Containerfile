# TEMPER viewer image for OpenShift.
# Runs as an arbitrary non-root user (restricted-v2 SCC) and listens on 8080. Country data is mounted at /data
# (read only) and the prepared nightly layers are cached on a volume at /cache.
FROM registry.access.redhat.com/ubi9/python-312:latest

WORKDIR /opt/app-root/src
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py evt.py bands.py lightroast.py rxmethod.py vectors.py ./
COPY static ./static

ENV TEMPER_HOST=0.0.0.0 \
    TEMPER_PORT=8080 \
    TEMPER_DATA_ROOT=/data \
    TEMPER_LR_ROOT=/data/_lightroast \
    TEMPER_CACHE=/cache \
    PYTHONUNBUFFERED=1

EXPOSE 8080
USER 1001
CMD ["python", "-B", "server.py"]
