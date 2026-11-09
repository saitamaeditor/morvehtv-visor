# MorvehTV Cuentas: solo Node, sin dependencias
FROM node:22-alpine
WORKDIR /app
COPY package.json *.mjs *.js ./
ENV NODE_ENV=production DATOS=/datos/datos.json
USER node
CMD ["node", "servidor.mjs"]
