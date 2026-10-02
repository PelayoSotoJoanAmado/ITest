import { useState, useEffect, useCallback, useMemo } from 'react';
import mesaService from '../services/mesaService';

export default function useMesas(zona = 'salon_principal') {
  const [listaCompleta, setListaCompleta] = useState(() => mesaService.getMesas());
  const [actividades, setActividades] = useState(() => mesaService.getActividades());

  const recargar = useCallback(async () => {
    // 1. Cargar estado actual de caché de inmediato
    setListaCompleta(mesaService.getMesas());
    setActividades(mesaService.getActividades());

    // 2. Sincronizar en segundo plano con PostgreSQL en InsForge
    try {
      const [mesasRemotas, actsRemotas] = await Promise.all([
        mesaService.fetchMesas(),
        mesaService.fetchActividades(),
      ]);
      if (mesasRemotas) setListaCompleta(mesasRemotas);
      if (actsRemotas) setActividades(actsRemotas);
    } catch (err) {
      console.warn('Error al sincronizar mesas remotas:', err);
    }
  }, []);

  useEffect(() => {
    // Sincronización inicial con PostgreSQL
    recargar();

    // Polling cada 5 segundos para mantener sincronizados consumos y estados en vivo
    const timer = setInterval(recargar, 5000);

    function onStorageEvent(e) {
      if (e.key === 'lys_mesas' || e.key === 'lys_actividades' || e.key === 'lys_pedidos') {
        recargar();
      }
    }

    window.addEventListener('storage', onStorageEvent);
    window.addEventListener('lys_mesas_updated', recargar);
    window.addEventListener('lys_actividades_updated', recargar);

    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', onStorageEvent);
      window.removeEventListener('lys_mesas_updated', recargar);
      window.removeEventListener('lys_actividades_updated', recargar);
    };
  }, [recargar]);

  // Derivación reactiva inmediata al cambiar zona
  const mesas = useMemo(() => {
    if (!zona || zona === 'todas') return listaCompleta;
    return listaCompleta.filter((m) => m.zona === zona);
  }, [listaCompleta, zona]);

  // Estadísticas calculadas al instante según la zona activa
  const estadisticas = useMemo(() => {
    const filtradas = (!zona || zona === 'todas') ? listaCompleta : listaCompleta.filter((m) => m.zona === zona);
    const total = filtradas.length || 1;
    const libres = filtradas.filter((m) => m.estado === 'libre').length;
    const ocupadas = filtradas.filter((m) => m.estado === 'ocupada').length;
    const reservadas = filtradas.filter((m) => m.estado === 'reservada').length;

    return {
      total,
      libres,
      ocupadas,
      reservadas,
      pctLibres: ((libres / total) * 100).toFixed(1),
      pctOcupadas: ((ocupadas / total) * 100).toFixed(1),
      pctReservadas: ((reservadas / total) * 100).toFixed(1),
    };
  }, [listaCompleta, zona]);

  return {
    mesas,
    estadisticas,
    actividades,
    recargar,
    liberarMesa: async (numero) => {
      await mesaService.liberarMesa(numero);
      recargar();
    },
    ocuparMesa: async (numero, pedidoId, total) => {
      await mesaService.abrirPedidoMesa({ numero, pedidoId, total });
      recargar();
    },
  };
}
