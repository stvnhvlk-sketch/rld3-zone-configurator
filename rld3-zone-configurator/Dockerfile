# Static-file add-on: nginx serves the configurator under HA ingress.
# BUILD_FROM is supplied by the Supervisor builder but unused — we pin nginx
# directly so the image is identical whether built by HA or by hand.
ARG BUILD_FROM
FROM nginx:1.27-alpine

# Ingress proxies to this port on all interfaces; no host port is exposed.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY www /www

# nginx:alpine's default entrypoint runs nginx in the foreground.
