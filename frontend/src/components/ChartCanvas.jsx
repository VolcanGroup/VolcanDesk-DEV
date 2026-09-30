import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';

Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
Chart.defaults.color = '#6b7280';
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(17, 24, 39, 0.9)';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;

// Wrapper genérico sobre Chart.js: destruye y recrea la instancia cada vez que
// cambian type/data/options — Chart.js no soporta bien reusar la misma
// instancia si el shape de `data` cambia (ej. número de datasets), y esta
// gráfica se recalcula cada 8s junto con el polling de tickets del dashboard.
export default function ChartCanvas({ type, data, options }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const dataKey = JSON.stringify(data);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, { type, data, options });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, dataKey, optionsKey]);

  return <canvas ref={canvasRef}></canvas>;
}
