# Documentación: EPIC 4 — Mesas y Pedidos (Sprint 2 - Backend)

Esta documentación resume la arquitectura, esquema de base de datos, funciones de servidor, endpoints y actividades implementadas en la rama **`feature/mesas-pedidos`** para conectar el sistema de **Pollería Lys** con la plataforma backend **InsForge (PostgreSQL)**.

---

## 1. Resumen de Actividades del Epic

| Ticket | Tarea | Estado | Solución Técnica |
| :--- | :--- | :--- | :--- |
| **SCRUM-276** | Como mesera, quiero abrir un pedido en una mesa y enviarlo a cocina | ✅ Completado | Pantalla `NuevoPedidoPage.jsx` conectada a función de servidor y tabla `pedidos`. |
| **SCRUM-277** | Consultar el estado de las mesas desde PostgreSQL | ✅ Completado | Tabla `mesas` en PostgreSQL consultada mediante `mesaService.fetchMesas()` y el hook `useMesas()`. |
| **SCRUM-278** | Crear una función de servidor para abrir un pedido y ocupar su mesa | ✅ Completado | Edge Function `abrir-pedido` desplegada en InsForge y función PL/pgSQL atómica `abrir_pedido_mesa`. |
| **SCRUM-279** | Permitir agregar productos y observaciones a un pedido abierto | ✅ Completado | Carga reactiva de comanda previa desde InsForge al abrir mesa ocupada y actualización (`upsert`) en backend. |
| **SCRUM-280** | Registrar el envío del pedido a cocina | ✅ Completado | Estado `estado_cocina = 'nuevo'` en tabla `pedidos` y evento registrado en `actividades_mesas`. |
| **SCRUM-281** | Registrar la solicitud de cuenta para caja | ✅ Completado | Método `solicitarCuentaMesa()` que actualiza `cuenta_solicitada = true` en PostgreSQL y avisa a caja. |
| **SCRUM-282** | Impedir dos pedidos activos simultáneos en una misma mesa | ✅ Completado | Restricción estricta mediante índice único parcial `idx_pedidos_activos_por_mesa` y validación en Edge Function. |
| **SCRUM-283** | Sustituir `lys_mesas` y escrituras directas a `lys_pedidos` | ✅ Completado | Migración de la fuente de verdad a PostgreSQL; `cajaService` y `mesaService` usan InsForge. |

---

## 2. Esquema de Base de Datos en PostgreSQL

El esquema se encuentra versionado en [`database/schema_mesas_pedidos.sql`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/database/schema_mesas_pedidos.sql).

### Tabla: `mesas`
Representa las mesas del local (Salón principal, Terraza, Segundo piso).
* `id`: Identificador numérico primario (`SERIAL`).
* `numero`: Número de mesa (`01`, `02`, ..., `16`) único (`VARCHAR(10)`).
* `capacidad`: Capacidad de comensales (`INT`).
* `forma`: Forma geométrica para renderizado en plano (`redonda`, `cuadrada`, `rectangular`).
* `estado`: Estado operativo (`libre`, `ocupada`, `reservada`).
* `zona`: Ubicación (`salon_principal`, `terraza`, `segundo_piso`).
* `pedido_id`: ID del pedido activo asignado a la mesa (`VARCHAR(50)`, nullable).
* `total_acumulado`: Total actual consumido (`NUMERIC(10,2)`).
* `inicio_at`: Timestamp de cuando se ocupó la mesa (`TIMESTAMPTZ`).
* Campos de reserva: `hora_reserva`, `cliente_reserva`, `telefono_reserva`, `comensales_reserva`.

### Tabla: `pedidos`
Almacena todas las comandas de mesas (y clientes).
* `id`: Código de orden (`PED-XXXX`).
* `mesa_numero`: Número de mesa asociada (`VARCHAR(10)`).
* `cliente`: Nombre del cliente o referencia de mesa.
* `mesera`: Nombre de la mesera que abrió o gestiona el pedido.
* `comensales`: Cantidad de personas sentadas.
* `estado`: Estado de pago (`pendiente`, `pagado`, `cancelado`).
* `estado_cocina`: Estado en cocina (`nuevo`, `en_preparacion`, `listo`, `entregado`).
* `cuenta_solicitada`: Bandera booleana para notificar a Caja (`BOOLEAN`).
* `observaciones`: Indicaciones especiales de la comanda (ej: sin mayonesa, papas crujientes).
* `items`: Detalle de productos en formato `JSONB` `[{ id, nombre, precio, cantidad, observacion }]`.
* `subtotal`, `igv`, `total`: Importes monetarios calculados.

### Restricción de Integridad (SCRUM-282):
Garantiza en el motor PostgreSQL que ninguna mesa pueda tener más de un pedido activo (no pagado ni cancelado) al mismo tiempo:
```sql
CREATE UNIQUE INDEX idx_pedidos_activos_por_mesa
ON pedidos (mesa_numero)
WHERE estado != 'pagado' AND estado != 'cancelado';
```

### Tabla: `actividades_mesas`
Historial de auditoría y timeline del salón.
* `id`: `SERIAL PRIMARY KEY`.
* `mesa_numero`: Número de mesa.
* `tipo`: Tipo de evento (`pedido_creado`, `pedido_actualizado`, `pedido_completado`, `reserva`).
* `titulo`, `descripcion`, `orden_codigo`, `tipo_color`.
* `fecha`: `TIMESTAMPTZ DEFAULT NOW()`.

---

## 3. Endpoints y Funciones de Servidor

### A. Edge Function InsForge (Serverless)
* **Nombre / Slug**: `abrir-pedido`
* **URL de despliegue**: `https://3j7i3wv9.function2.insforge.app`
* **Método**: `POST`
* **Payload**:
  ```json
  {
    "mesaNumero": "03",
    "mesera": "Ana Rodríguez",
    "comensales": 4,
    "observaciones": "Papas bien doradas",
    "items": [
      { "id": 1, "nombre": "1 Pollo a la Brasa", "precio": 65.0, "cantidad": 1 }
    ],
    "subtotal": 55.08,
    "igv": 9.92,
    "total": 65.0,
    "pedidoId": null
  }
  ```
* **Comportamiento**:
  1. Verifica que la mesa exista.
  2. Valida que no esté ocupada por otra orden activa (SCRUM-282).
  3. Inserta o actualiza el pedido en `pedidos` con `estadoCocina: 'nuevo'`.
  4. Actualiza `mesas` a `estado: 'ocupada'`, asigna `pedido_id` y `total_acumulado`.
  5. Inserta la actividad en `actividades_mesas`.

### B. Procedimientos Almacenados en PostgreSQL (RPC)
1. **`abrir_pedido_mesa(...)`**:
   Ejecución atómica dentro de una sola transacción en base de datos.
2. **`solicitar_cuenta_mesa(p_mesa_numero VARCHAR)`** (SCRUM-281):
   Marca `cuenta_solicitada = TRUE` en el pedido activo de la mesa y registra la actividad para el panel de caja.
3. **`liberar_mesa(p_mesa_numero VARCHAR)`**:
   Marca el pedido como `pagado`, limpia la mesa a `estado: 'libre'` y resetea montos.

### C. Endpoints REST (Vía InsForge PostgREST SDK)
* **`insforge.database.from('mesas').select('*')`**: Consulta el plano y estado de las mesas en tiempo real.
* **`insforge.database.from('pedidos').select('*').eq('id', pedidoId)`**: Obtiene los ítems y notas de una orden abierta.
* **`insforge.database.from('actividades_mesas').select('*')`**: Timeline de actividades del salón.

---

## 4. Archivos Modificados / Creados en el Repositorio

* [`src/lib/insforge.js`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/lib/insforge.js): Cliente singleton oficial de InsForge.
* [`src/services/mesaService.js`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/services/mesaService.js): Métodos de consulta y mutación conectadas a PostgreSQL y Edge Function.
* [`src/hooks/useMesas.js`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/hooks/useMesas.js): Hook reactivo con sincronización automática en vivo.
* [`src/pages/NuevoPedidoPage.jsx`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/pages/NuevoPedidoPage.jsx): Flujo de toma de pedido, edición de observaciones y envío a cocina.
* [`src/components/mesas/MesaDetalleModal.jsx`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/components/mesas/MesaDetalleModal.jsx): Acciones de mesa (solicitar cuenta a caja, liberar mesa).
* [`src/services/cajaService.js`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/src/services/cajaService.js): Liberación de mesas sincronizada con InsForge tras cobro.
* [`functions/abrir-pedido/index.js`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/functions/abrir-pedido/index.js): Código de la Edge Function en Deno/InsForge.
* [`database/schema_mesas_pedidos.sql`](file:///c:/Users/LAB-USR-LNORTE/Documents/T/ITest/database/schema_mesas_pedidos.sql): Definición DDL y scripts SQL.
