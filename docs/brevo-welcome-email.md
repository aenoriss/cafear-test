# Welcome Email en Brevo

La experiencia agrega cada Lead a la lista **Nomad Hub — AR bolsa** (carpeta *Experiencias*), con los campos `NOMBRE`, `ORIGEN = bolsa-ar` y `CONSENTIMIENTO` (fecha). La lista y los campos se crean solos con el primer Lead. Brevo manda el Welcome Email cuando un contacto entra a esa lista; quien ya estaba en la lista no lo vuelve a recibir.

## Configurarlo (una vez, en app.brevo.com)

1. **Automatizaciones → Crear automatización → Mensaje de bienvenida** (o "Crear desde cero").
2. **Punto de entrada:** "Un contacto se agrega a una lista" → elegí **Nomad Hub — AR bolsa**.
3. **Acción:** "Enviar un email" → crear el email con el texto de abajo. Remitente: un email de `@nomadhub.ar` verificado en Brevo (Remitentes y dominios).
4. Activá la automatización.

## Texto del email

**Asunto:** Tu 15% off en Nomad Hub, {{ contact.NOMBRE }}

**Vista previa:** Tu código de descuento te espera adentro.

> Hola {{ contact.NOMBRE }},
>
> Gracias por escanear la bolsa de Nomad Hub. Acá tenés tu código:
>
> **NOMAD15**
>
> Te da un 15% off en tu próxima compra en nuestra tienda online. Copialo y pegalo al pagar.
>
> [Ir a la tienda](https://nomadhub.ar/)
>
> Fuel for nomads,
> El equipo de Nomad Hub

Brevo agrega solo el enlace para darse de baja al pie del email.

**Pendiente:** cambiar el 15% y el enlace de la tienda cuando estén definidos (también en `offer.js`: `PERCENT` y `STORE_URL`).
