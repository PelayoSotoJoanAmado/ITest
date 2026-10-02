import { createClient } from 'npm:@insforge/sdk';

export default async function(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      mesaNumero,
      mesera = 'Mesera',
      comensales = 2,
      observaciones = '',
      items = [],
      subtotal = 0,
      igv = 0,
      total = 0,
      pedidoId = null
    } = body;

    if (!mesaNumero) {
      return new Response(JSON.stringify({ error: 'mesaNumero es obligatorio' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const client = createClient({
      baseUrl: Deno.env.get('INSFORGE_BASE_URL') || 'https://3j7i3wv9.us-east.insforge.app',
      anonKey: Deno.env.get('ANON_KEY') || 'anon_b230028c00d10bbc0b54f8603d9c56658734f111e64906602aa8f09003cb8686'
    });

    const numNormalizado = String(mesaNumero).padStart(2, '0');
    const { data: mesas, error: mesaErr } = await client.database
      .from('mesas')
      .select('*')
      .eq('numero', numNormalizado);

    if (mesaErr || !mesas || mesas.length === 0) {
      return new Response(JSON.stringify({ error: `Mesa ${mesaNumero} no encontrada` }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const mesa = mesas[0];

    // SCRUM-279: Si la mesa ya tiene un pedido activo, reutilizarlo para agregar ítems/observaciones
    let idFinal = pedidoId || mesa.pedido_id;

    if (!idFinal) {
      // Consultar si hay orden activa previa no pagada
      const { data: pedidosActivos } = await client.database
        .from('pedidos')
        .select('id')
        .eq('mesa_numero', numNormalizado)
        .neq('estado', 'pagado')
        .neq('estado', 'cancelado')
        .limit(1);

      if (pedidosActivos && pedidosActivos.length > 0) {
        idFinal = pedidosActivos[0].id;
      } else {
        idFinal = `PED-${Math.floor(1000 + Math.random() * 9000)}`;
      }
    }

    // SCRUM-282: Impedir dos pedidos activos distintos en la misma mesa
    if (mesa.estado === 'ocupada' && mesa.pedido_id && idFinal !== mesa.pedido_id) {
      return new Response(JSON.stringify({
        error: `La mesa ${numNormalizado} ya se encuentra ocupada con el pedido activo ${mesa.pedido_id}.`
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { error: pedidoErr } = await client.database
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
        updated_at: new Date().toISOString()
      }]);

    if (pedidoErr) {
      return new Response(JSON.stringify({ error: pedidoErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    await client.database
      .from('mesas')
      .update({
        estado: 'ocupada',
        pedido_id: idFinal,
        total_acumulado: Number(total),
        inicio_at: mesa.inicio_at || new Date().toISOString(),
        hora_reserva: null,
        cliente_reserva: null,
        telefono_reserva: null,
        comensales_reserva: null,
        updated_at: new Date().toISOString()
      })
      .eq('numero', numNormalizado);

    await client.database
      .from('actividades_mesas')
      .insert([{
        mesa_numero: numNormalizado,
        tipo: 'pedido_creado',
        titulo: `Mesa ${numNormalizado}`,
        descripcion: `Pedido enviado a cocina por ${mesera}`,
        orden_codigo: `Orden #${idFinal}`,
        tipo_color: 'rojo',
        fecha: new Date().toISOString()
      }]);

    return new Response(JSON.stringify({
      success: true,
      pedidoId: idFinal,
      mensaje: 'Pedido guardado y mesa sincronizada con éxito'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
