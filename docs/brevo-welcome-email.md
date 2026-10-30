# Welcome Email en Brevo

La experiencia agrega cada Lead a la lista **Nomad Hub — AR bolsa** (carpeta *Experiencias*), con los campos `NOMBRE`, `ORIGEN = bolsa-ar` y `CONSENTIMIENTO` (fecha). Si el contacto no estaba en esa lista, `api/lead.js` le manda el Welcome Email: la plantilla **Nomad Hub — Bienvenida AR bolsa**. Quien ya estaba en la lista no lo vuelve a recibir. No hace falta ninguna automatización en el panel de Brevo.

## Editar el email

La plantilla se crea sola con el primer Lead y después se edita en Brevo: **Campañas → Plantillas → Nomad Hub — Bienvenida AR bolsa** (texto, asunto y remitente). El código nunca la pisa. Para el nombre del contacto usá `{{ params.nombre }}`.

## Remitente

Hoy sale del remitente 1 de Brevo, el único verificado (una dirección de Gmail): sirve para la etapa de prueba, pero los envíos desde Gmail a través de Brevo suelen caer en spam. Antes de la campaña real:

1. Autenticar el dominio `nomadhub.ar` en Brevo (Remitentes, dominios e IP dedicadas → Dominios): Brevo da unos registros DNS para cargar en Hostinger.
2. Crear el remitente `hola@nomadhub.ar` (con la casilla funcionando, para las respuestas).
3. Cambiar el remitente en la plantilla, o definir `BREVO_SENDER_ID` en Vercel con el id del nuevo remitente si la plantilla todavía no existe.

**Descuento:** 10% en la próxima compra, código `NOMAD10`. Si cambia, hay que cambiarlo en la plantilla de Brevo, en `offer.js` (`CODE`, `PERCENT`) y en `api/lead.js` (solo afecta a la primera versión de la plantilla).

**Pendiente:** el enlace de la tienda cuando exista (`STORE_URL` en `offer.js` y `api/lead.js`, y el botón de la plantilla).
