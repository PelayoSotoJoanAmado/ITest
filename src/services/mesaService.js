import insforge from '../lib/insforge';
import { SEED_MESAS, SEED_ACTIVIDADES, ESTADOS_MESA } from '../data/mesasData';

const MESAS_KEY = 'lys_mesas';
const ACTIVIDADES_KEY = 'lys_actividades';
const PEDIDOS_KEY = 'lys_pedidos';

// Cache en memoria para renderizado reactivo síncrono instantáneo
let cacheMesas = null;
let cacheActividades = null;

function normalizarMesa(row) {
  if (!row) return null;
  return {
    id: row.id,
    numero: String(row.numero).padStart(2, '0'),
    capacidad: row.capacidad || 4,
    forma: row.forma || 'cuadrada',
    estado: row.estado || ESTADOS_MESA.LIBRE,
    zona: row.zona || 'salon_principal',
    pedidoId: row.pedido_id ?? row.pedidoId ?? null,
    totalAcumulado: Number(row.total_acumulado ?? row.totalAcumulado ?? 0),
    inicioAt: row.inicio_at ?? row.inicioAt ?? null,
    horaReserva: row.hora_reserva ?? row.horaReserva ?? null,
    clienteReserva: row.cliente_reserva ?? row.clienteReserva ?? null,
    telefonoReserva: row.telefono_reserva ?? row.telefonoReserva ?? null,
    comensalesReserva: row.comensales_reserva ?? row.comensalesReserva ?? null,
  };
}

function inicializarCache() {
  if (cacheMesas) return cacheMesas;
  try {
    const raw = localStorage.getItem(MESAS_KEY);
    cacheMesas = raw ? JSON.parse(raw).map(normalizarMesa) : SEED_MESAS.map(normalizarMesa);
  } catch {
    cacheMesas = SEED_MESAS.map(normalizarMesa);
  }
  return cacheMesas;
}

function guardarEnCacheLocal(mesas) {
  cacheMesas = mesas.map(normalizarMesa);
  try {
    localStorage.setItem(MESAS_KEY, JSON.stringify(cacheMesas));
  } catch (err) {
    console.error('Error al guardar caché de mesas:', err);
  }
  window.dispatchEvent(new Event('lys_mesas_updated'));
}

/**
 * SCRUM-277: Consultar el estado de las mesas desde PostgreSQL en InsForge
 */
export async function fetchMesas() {
  try {
    const { data, error } = await insforge.database
      .from('mesas')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.warn('Advertencia al consultar mesas en PostgreSQL, usando caché:', error.message);
      return getMesas();
    }

    if (data && data.length > 0) {
      const normalizadas = data.map(normalizarMesa);
      guardarEnCacheLocal(normalizadas);
      return normalizadas;
    }
  } catch (err) {
    console.error('Error al conectar con InsForge en fetchMesas:', err);
  }
  return getMesas();
}

/**
 * Retorna las mesas desde la memoria/caché local sincronizada con PostgreSQL
 */
export function getMesas() {
  const mesas = inicializarCache();

  // Sincronizar montos si hay pedidos locales o en memoria
  try {
    const rawPedidos = localStorage.getItem(PEDIDOS_KEY);
    const pedidos = rawPedidos ? JSON.parse(rawPedidos) : [];
    return mesas.map((m) => {
      if (m.estado === ESTADOS_MESA.OCUPADA && m.pedidoId) {
        const pedido = pedidos.find((p) => p.id === m.pedidoId);
        if (pedido && pedido.total > 0 && pedido.total !== m.totalAcumulado) {
          return { ...m, totalAcumulado: Number(pedido.total) };
        }
      }
      return m;
    });
  } catch {
    return mesas;
  }
}

export function getMesaById(id) {
  const mesas = getMesas();
  return mesas.find((m) => m.id === Number(id)) || null;
}

export function getMesaByNumero(numero) {
  const mesas = getMesas();
  const numNormalizado = String(numero).padStart(2, '0');
  return mesas.find((m) => String(m.numero).padStart(2, '0') === numNormalizado) || null;
}

/**
 * SCRUM-278 & SCRUM-282: Función de servidor para abrir pedido y ocupar mesa
 * Impide dos pedidos activos simultáneos en la misma mesa (SCRUM-282).
 */
export async function abrirPedidoMesa({
  numero,
  mesera = 'Mesera',
  comensales = 2,
  observaciones = '',
  items = [],
  subtotal = 0,
  igv = 0,
  total = 0,
  pedidoId = null,
}) {
  const numNormalizado = String(numero).padStart(2, '0');

  // Validación previa local para retroalimentación instantánea
  const mesaActual = getMesaByNumero(numNormalizado);
  if (mesaActual && mesaActual.estado === ESTADOS_MESA.OCUPADA && mesaActual.pedidoId && (!pedidoId || mesaActual.pedidoId !== pedidoId)) {
    throw new Error(`La mesa ${numNormalizado} ya se encuentra ocupada con el pedido ${mesaActual.pedidoId}. No se pueden tener dos pedidos activos simultáneos.`);
  }

  // 1. Invocar Serverless Edge Function en InsForge
  try {
    const { data, error } = await insforge.functions.invoke('abrir-pedido', {
      body: {
        mesaNumero: numNormalizado,
        mesera,
        comensales,
        observaciones,
        items,
        subtotal,
        igv,
        total,
        pedidoId,
      },
    });

    if (error) {
      throw new Error(error.message || 'Error al invocar edge function abrir-pedido');
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    // 2. Refrescar estado desde PostgreSQL
    await fetchMesas();
    return data;
  } catch (funcErr) {
    console.warn('Fallback a operación directa en PostgreSQL:', funcErr.message);

    // Fallback: Ejecución directa en PostgreSQL mediante PostgREST si la función no responde
    const idFinal = pedidoId || `PED-${Date.now().toString().slice(-4)}`;

    const { error: errPedido } = await insforge.database
      .from('pedidos')
      .upsert([{
        id: idFinal,
        mesa_numero: numNormalizado,
        cliente: `Mesa ${numNormalizado}`,
        mesera,
        comensales: Number(comensales),
        estado: 'pendiente',
        estado_cocina: 'nuevo',
        cuenta_solicitada: false,
        observaciones: (observaciones || '').trim(),
        items,
        subtotal: Number(subtotal),
        igv: Number(igv),
        total: Number(total),
        updated_at: new Date().toISOString(),
      }]);

    if (errPedido) {
      throw new Error(errPedido.message);
    }

    const { error: errMesa } = await insforge.database
      .from('mesas')
      .update({
        estado: ESTADOS_MESA.OCUPADA,
        pedido_id: idFinal,
        total_acumulado: Number(total),
        inicio_at: new Date().toISOString(),
        hora_reserva: null,
        cliente_reserva: null,
        telefono_reserva: null,
        comensales_reserva: null,
        updated_at: new Date().toISOString(),
      })
      .eq('numero', numNormalizado);

    if (errMesa) {
      throw new Error(errMesa.message);
    }

    await registrarActividad({
      mesaNumero: numNormalizado,
      tipo: 'pedido_creado',
      titulo: `Mesa ${numNormalizado}`,
      descripcion: `Pedido enviado a cocina por ${mesera}`,
      ordenCodigo: `Orden #${idFinal}`,
      tipoColor: 'rojo',
    });

    await fetchMesas();
    return { success: true, pedidoId: idFinal };
  }
}

/**
 * SCRUM-281: Registrar solicitud de cuenta para caja
 */
export async function solicitarCuentaMesa(numero) {
  const numNormalizado = String(numero).padStart(2, '0');
  const mesa = getMesaByNumero(numNormalizado);

  if (!mesa?.pedidoId) {
    throw new Error(`La mesa ${numNormalizado} no tiene un pedido activo.`);
  }

  try {
    await insforge.database
      .from('pedidos')
      .update({ cuenta_solicitada: true, updated_at: new Date().toISOString() })
      .eq('id', mesa.pedidoId);

    await registrarActividad({
      mesaNumero: numNormalizado,
      tipo: 'pedido_actualizado',
      titulo: `Mesa ${numNormalizado}`,
      descripcion: 'Cuenta solicitada para caja',
      ordenCodigo: mesa.pedidoId,
      tipoColor: 'amarillo',
    });
  } catch (err) {
    console.error('Error al registrar solicitud de cuenta en InsForge:', err);
  }

  // Reflejar localmente
  try {
    const raw = localStorage.getItem(PEDIDOS_KEY);
    const pedidos = raw ? JSON.parse(raw) : [];
    const actualizados = pedidos.map((p) => (p.id === mesa.pedidoId ? { ...p, cuentaSolicitada: true } : p));
    localStorage.setItem(PEDIDOS_KEY, JSON.stringify(actualizados));
    window.dispatchEvent(new Event('storage'));
  } catch {}

  return { success: true, pedidoId: mesa.pedidoId };
}

/**
 * Liberar una mesa y marcar su pedido como pagado en PostgreSQL
 */
export async function liberarMesa(numero) {
  const numNormalizado = String(numero).padStart(2, '0');
  const mesa = getMesaByNumero(numNormalizado);

  try {
    if (mesa?.pedidoId) {
      await insforge.database
        .from('pedidos')
        .update({ estado: 'pagado', updated_at: new Date().toISOString() })
        .eq('id', mesa.pedidoId);
    }

    await insforge.database
      .from('mesas')
      .update({
        estado: ESTADOS_MESA.LIBRE,
        pedido_id: null,
        total_acumulado: 0.00,
        inicio_at: null,
        hora_reserva: null,
        cliente_reserva: null,
        telefono_reserva: null,
        comensales_reserva: null,
        updated_at: new Date().toISOString(),
      })
      .eq('numero', numNormalizado);

    await registrarActividad({
      mesaNumero: numNormalizado,
      tipo: 'pedido_completado',
      titulo: `Mesa ${numNormalizado}`,
      descripcion: 'Mesa liberada',
      ordenCodigo: mesa?.pedidoId ? `Orden #${mesa.pedidoId}` : '',
      tipoColor: 'verde',
    });

    await fetchMesas();
  } catch (err) {
    console.error('Error al liberar mesa en InsForge:', err);
  }

  // Actualización optimista local
  const mesas = getMesas();
  const actualizadas = mesas.map((m) => {
    if (String(m.numero).padStart(2, '0') === numNormalizado) {
      return {
        ...m,
        estado: ESTADOS_MESA.LIBRE,
        pedidoId: null,
        inicioAt: null,
        totalAcumulado: 0,
        horaReserva: null,
        clienteReserva: null,
        telefonoReserva: null,
        comensalesReserva: null,
      };
    }
    return m;
  });

  guardarEnCacheLocal(actualizadas);
  return actualizadas.find((m) => String(m.numero).padStart(2, '0') === numNormalizado);
}

/**
 * Reservar una mesa
 */
export async function reservarMesa(numero, { cliente, hora, comensales, telefono } = {}) {
  const numNormalizado = String(numero).padStart(2, '0');

  try {
    await insforge.database
      .from('mesas')
      .update({
        estado: ESTADOS_MESA.RESERVADA,
        hora_reserva: hora || '20:00',
        cliente_reserva: (cliente || 'Cliente Reserva').trim(),
        telefono_reserva: (telefono || '').trim(),
        comensales_reserva: Number(comensales) || 4,
        updated_at: new Date().toISOString(),
      })
      .eq('numero', numNormalizado);

    await registrarActividad({
      mesaNumero: numNormalizado,
      tipo: 'reserva',
      titulo: `Mesa ${numNormalizado}`,
      descripcion: `Reserva confirmada a nombre de ${(cliente || '').trim()}`,
      ordenCodigo: `${hora || '20:00'} hrs`,
      tipoColor: 'amarillo',
    });

    await fetchMesas();
  } catch (err) {
    console.error('Error al reservar mesa en InsForge:', err);
  }

  const mesas = getMesas();
  const actualizadas = mesas.map((m) => {
    if (String(m.numero).padStart(2, '0') === numNormalizado) {
      return {
        ...m,
        estado: ESTADOS_MESA.RESERVADA,
        horaReserva: hora || '20:00',
        clienteReserva: (cliente || 'Cliente Reserva').trim(),
        telefonoReserva: (telefono || '').trim(),
        comensalesReserva: Number(comensales) || m.capacidad,
      };
    }
    return m;
  });

  guardarEnCacheLocal(actualizadas);
  return actualizadas.find((m) => String(m.numero).padStart(2, '0') === numNormalizado);
}

export function getEstadisticasMesas(zona = 'salon_principal') {
  const mesas = getMesas().filter((m) => !zona || m.zona === zona);
  const total = mesas.length || 1;

  const libres = mesas.filter((m) => m.estado === ESTADOS_MESA.LIBRE).length;
  const ocupadas = mesas.filter((m) => m.estado === ESTADOS_MESA.OCUPADA).length;
  const reservadas = mesas.filter((m) => m.estado === ESTADOS_MESA.RESERVADA).length;

  return {
    total,
    libres,
    ocupadas,
    reservadas,
    pctLibres: ((libres / total) * 100).toFixed(1),
    pctOcupadas: ((ocupadas / total) * 100).toFixed(1),
    pctReservadas: ((reservadas / total) * 100).toFixed(1),
  };
}

/**
 * Consultar actividades recientes desde PostgreSQL en InsForge
 */
export async function fetchActividades() {
  try {
    const { data, error } = await insforge.database
      .from('actividades_mesas')
      .select('*')
      .order('id', { ascending: false })
      .limit(25);

    if (!error && data && data.length > 0) {
      const lista = data.map((it) => ({
        id: `ACT-${it.id}`,
        mesaNumero: String(it.mesa_numero).padStart(2, '0'),
        tipo: it.tipo,
        titulo: it.titulo,
        descripcion: it.descripcion,
        ordenCodigo: it.orden_codigo,
        hora: new Date(it.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        tipoColor: it.tipo_color,
        createdAt: it.fecha,
      }));
      cacheActividades = lista;
      localStorage.setItem(ACTIVIDADES_KEY, JSON.stringify(lista));
      window.dispatchEvent(new Event('lys_actividades_updated'));
      return lista;
    }
  } catch (err) {
    console.error('Error al consultar actividades en InsForge:', err);
  }
  return getActividades();
}

export function getActividades() {
  if (cacheActividades) return cacheActividades;
  try {
    const raw = localStorage.getItem(ACTIVIDADES_KEY);
    cacheActividades = raw ? JSON.parse(raw) : SEED_ACTIVIDADES;
  } catch {
    cacheActividades = SEED_ACTIVIDADES;
  }
  return cacheActividades;
}

export async function registrarActividad({ mesaNumero, tipo, titulo, descripcion, ordenCodigo, tipoColor }) {
  const numNormalizado = String(mesaNumero).padStart(2, '0');
  const ahora = new Date();
  const horaStr = ahora.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const nuevaActividad = {
    id: `ACT-${Date.now()}`,
    mesaNumero: numNormalizado,
    tipo: tipo || 'pedido_creado',
    titulo: titulo || `Mesa ${numNormalizado}`,
    descripcion: descripcion || 'Pedido actualizado',
    ordenCodigo: ordenCodigo || '',
    hora: horaStr,
    tipoColor: tipoColor || 'rojo',
    createdAt: ahora.toISOString(),
  };

  try {
    await insforge.database
      .from('actividades_mesas')
      .insert([{
        mesa_numero: numNormalizado,
        tipo: tipo || 'pedido_creado',
        titulo: titulo || `Mesa ${numNormalizado}`,
        descripcion: descripcion || 'Pedido actualizado',
        orden_codigo: ordenCodigo || '',
        tipo_color: tipoColor || 'rojo',
        fecha: ahora.toISOString(),
      }]);
  } catch (err) {
    console.error('Error al registrar actividad en InsForge:', err);
  }

  const previas = getActividades();
  const listaActualizada = [nuevaActividad, ...previas].slice(0, 25);
  cacheActividades = listaActualizada;
  try {
    localStorage.setItem(ACTIVIDADES_KEY, JSON.stringify(listaActualizada));
  } catch {}
  window.dispatchEvent(new Event('lys_actividades_updated'));
  return nuevaActividad;
}

export function getMinutosOcupada(inicioAt) {
  if (!inicioAt) return 0;
  const diffMs = Date.now() - new Date(inicioAt).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins > 180) return 35;
  return mins;
}

export default {
  fetchMesas,
  getMesas,
  getMesaById,
  getMesaByNumero,
  abrirPedidoMesa,
  liberarMesa,
  reservarMesa,
  solicitarCuentaMesa,
  getEstadisticasMesas,
  fetchActividades,
  getActividades,
  registrarActividad,
  getMinutosOcupada,
};
