-- Migración para EPIC 4: Mesas y Pedidos (Sprint 2 - Backend)
-- InsForge PostgreSQL Schema

-- 1. Tabla de Mesas (SCRUM-277)
CREATE TABLE IF NOT EXISTS mesas (
    id SERIAL PRIMARY KEY,
    numero VARCHAR(10) UNIQUE NOT NULL,
    capacidad INT NOT NULL DEFAULT 4,
    forma VARCHAR(30) DEFAULT 'cuadrada',
    estado VARCHAR(20) NOT NULL DEFAULT 'libre',
    zona VARCHAR(50) NOT NULL DEFAULT 'salon_principal',
    pedido_id VARCHAR(50) NULL,
    total_acumulado NUMERIC(10,2) DEFAULT 0.00,
    inicio_at TIMESTAMPTZ NULL,
    hora_reserva VARCHAR(20) NULL,
    cliente_reserva VARCHAR(100) NULL,
    telefono_reserva VARCHAR(50) NULL,
    comensales_reserva INT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabla de Pedidos
CREATE TABLE IF NOT EXISTS pedidos (
    id VARCHAR(50) PRIMARY KEY,
    mesa_numero VARCHAR(10) NOT NULL,
    cliente VARCHAR(100) DEFAULT 'Mesa',
    mesera VARCHAR(100) DEFAULT 'Mesera',
    comensales INT DEFAULT 2,
    estado VARCHAR(30) DEFAULT 'pendiente',
    estado_cocina VARCHAR(30) DEFAULT 'nuevo',
    cuenta_solicitada BOOLEAN DEFAULT FALSE,
    observaciones TEXT DEFAULT '',
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(10,2) DEFAULT 0.00,
    igv NUMERIC(10,2) DEFAULT 0.00,
    total NUMERIC(10,2) DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. SCRUM-282: Restricción para impedir dos pedidos activos simultáneos en una misma mesa
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_activos_por_mesa
ON pedidos (mesa_numero)
WHERE estado != 'pagado' AND estado != 'cancelado';

-- 4. Tabla de Actividades de Mesas
CREATE TABLE IF NOT EXISTS actividades_mesas (
    id SERIAL PRIMARY KEY,
    mesa_numero VARCHAR(10),
    tipo VARCHAR(50),
    titulo VARCHAR(100),
    descripcion TEXT,
    orden_codigo VARCHAR(50),
    tipo_color VARCHAR(30) DEFAULT 'rojo',
    fecha TIMESTAMPTZ DEFAULT NOW()
);

-- 5. SCRUM-278: Función atómica para abrir pedido y ocupar mesa
CREATE OR REPLACE FUNCTION abrir_pedido_mesa(
    p_mesa_numero VARCHAR,
    p_mesera VARCHAR DEFAULT 'Mesera',
    p_comensales INT DEFAULT 2,
    p_observaciones TEXT DEFAULT '',
    p_items JSONB DEFAULT '[]'::jsonb,
    p_subtotal NUMERIC DEFAULT 0,
    p_igv NUMERIC DEFAULT 0,
    p_total NUMERIC DEFAULT 0,
    p_pedido_id VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_pedido_id VARCHAR;
    v_mesa_actual RECORD;
    v_pedido JSONB;
BEGIN
    SELECT * INTO v_mesa_actual FROM mesas WHERE LPAD(numero, 2, '0') = LPAD(p_mesa_numero, 2, '0') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'La mesa % no existe.', p_mesa_numero;
    END IF;

    -- SCRUM-282: Validación previa a nivel lógico
    IF v_mesa_actual.estado = 'ocupada' AND v_mesa_actual.pedido_id IS NOT NULL AND (p_pedido_id IS NULL OR v_mesa_actual.pedido_id != p_pedido_id) THEN
        RAISE EXCEPTION 'La mesa % ya se encuentra ocupada con el pedido activo %.', p_mesa_numero, v_mesa_actual.pedido_id;
    END IF;

    IF p_pedido_id IS NOT NULL AND p_pedido_id <> '' THEN
        v_pedido_id := p_pedido_id;
    ELSE
        v_pedido_id := 'PED-' || LPAD((COALESCE((SELECT COUNT(*) FROM pedidos), 0) + 1001)::TEXT, 4, '0');
    END IF;

    INSERT INTO pedidos (
        id, mesa_numero, cliente, mesera, comensales, estado, estado_cocina,
        cuenta_solicitada, observaciones, items, subtotal, igv, total, created_at, updated_at
    ) VALUES (
        v_pedido_id, LPAD(p_mesa_numero, 2, '0'), 'Mesa ' || LPAD(p_mesa_numero, 2, '0'),
        p_mesera, p_comensales, 'pendiente', 'nuevo',
        FALSE, p_observaciones, p_items, p_subtotal, p_igv, p_total, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        items = EXCLUDED.items,
        observaciones = EXCLUDED.observaciones,
        subtotal = EXCLUDED.subtotal,
        igv = EXCLUDED.igv,
        total = EXCLUDED.total,
        comensales = EXCLUDED.comensales,
        updated_at = NOW();

    UPDATE mesas SET
        estado = 'ocupada',
        pedido_id = v_pedido_id,
        total_acumulado = p_total,
        inicio_at = COALESCE(inicio_at, NOW()),
        hora_reserva = NULL,
        cliente_reserva = NULL,
        telefono_reserva = NULL,
        comensales_reserva = NULL,
        updated_at = NOW()
    WHERE LPAD(numero, 2, '0') = LPAD(p_mesa_numero, 2, '0');

    INSERT INTO actividades_mesas (mesa_numero, tipo, titulo, descripcion, orden_codigo, tipo_color)
    VALUES (
        LPAD(p_mesa_numero, 2, '0'),
        'pedido_creado',
        'Mesa ' || LPAD(p_mesa_numero, 2, '0'),
        'Pedido enviado a cocina por ' || p_mesera,
        'Orden #' || v_pedido_id,
        'rojo'
    );

    SELECT to_jsonb(p) INTO v_pedido FROM pedidos p WHERE p.id = v_pedido_id;
    RETURN jsonb_build_object(
        'success', true,
        'pedido_id', v_pedido_id,
        'pedido', v_pedido,
        'mensaje', 'Pedido abierto y mesa ocupada con éxito'
    );
END;
$$;

-- 6. SCRUM-281: Función para registrar solicitud de cuenta para caja
CREATE OR REPLACE FUNCTION solicitar_cuenta_mesa(p_mesa_numero VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_pedido_id VARCHAR;
BEGIN
    SELECT pedido_id INTO v_pedido_id FROM mesas WHERE LPAD(numero, 2, '0') = LPAD(p_mesa_numero, 2, '0');
    IF v_pedido_id IS NULL THEN
        RAISE EXCEPTION 'La mesa % no tiene un pedido activo.', p_mesa_numero;
    END IF;

    UPDATE pedidos SET cuenta_solicitada = TRUE, updated_at = NOW() WHERE id = v_pedido_id;

    INSERT INTO actividades_mesas (mesa_numero, tipo, titulo, descripcion, orden_codigo, tipo_color)
    VALUES (
        LPAD(p_mesa_numero, 2, '0'),
        'pedido_actualizado',
        'Mesa ' || LPAD(p_mesa_numero, 2, '0'),
        'Cuenta solicitada para caja',
        'Orden #' || v_pedido_id,
        'amarillo'
    );

    RETURN jsonb_build_object('success', true, 'pedido_id', v_pedido_id, 'mensaje', 'Cuenta solicitada para caja');
END;
$$;

-- 7. Función para liberar mesa
CREATE OR REPLACE FUNCTION liberar_mesa(p_mesa_numero VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_pedido_id VARCHAR;
BEGIN
    SELECT pedido_id INTO v_pedido_id FROM mesas WHERE LPAD(numero, 2, '0') = LPAD(p_mesa_numero, 2, '0');

    IF v_pedido_id IS NOT NULL THEN
        UPDATE pedidos SET estado = 'pagado', updated_at = NOW() WHERE id = v_pedido_id;
    END IF;

    UPDATE mesas SET
        estado = 'libre',
        pedido_id = NULL,
        total_acumulado = 0.00,
        inicio_at = NULL,
        hora_reserva = NULL,
        cliente_reserva = NULL,
        telefono_reserva = NULL,
        comensales_reserva = NULL,
        updated_at = NOW()
    WHERE LPAD(numero, 2, '0') = LPAD(p_mesa_numero, 2, '0');

    INSERT INTO actividades_mesas (mesa_numero, tipo, titulo, descripcion, orden_codigo, tipo_color)
    VALUES (
        LPAD(p_mesa_numero, 2, '0'),
        'pedido_completado',
        'Mesa ' || LPAD(p_mesa_numero, 2, '0'),
        'Mesa liberada',
        COALESCE('Orden #' || v_pedido_id, ''),
        'verde'
    );

    RETURN jsonb_build_object('success', true, 'mensaje', 'Mesa liberada correctamente');
END;
$$;
