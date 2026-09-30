// Helper functions for the application

// Quita acentos y pasa a minúsculas — para comparar/buscar texto ignorando
// tildes (ej. "gonzalez" debe encontrar "González"). Antes existían dos copias
// idénticas de esto (Users.jsx como `normalizeText`, Tickets.jsx como
// `normalize`, local a una función) — si alguien ajustaba una sin la otra, el
// buscador se comportaba distinto en cada pantalla sin aviso.
export const normalizeText = (str) => (str ?? '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Format date to readable string
export const formatDate = (date) => {
    if (!date) return 'N/A';
    const d = new Date(date);
    return d.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// Versión compacta sin año (ej. "17 sep · 10:21") — pensada para columnas de
// tabla angostas, donde formatDate ("17 sept 2026, 10:21") pesa demasiado
// visualmente (a pedido del usuario, 2026-09-18). El año se sigue mostrando
// completo en formatDate, usado en la ficha del ticket. Meses fijos a mano
// (no Intl) para garantizar "sep" de 3 letras — el short de es-ES da "sept"
// para septiembre específicamente, inconsistente con el resto (3 letras).
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const formatDateCompact = (date) => {
    if (!date) return 'N/A';
    const d = new Date(date);
    const day = d.getDate();
    const month = MESES_CORTOS[d.getMonth()];
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${day} ${month} · ${hours}:${minutes}`;
};

// Píldora de fecha del hilo de conversación estilo WhatsApp (ej.
// "24 DE AGOSTO, 2026") — agrupa mensajes por día (rediseño 2026-09-18).
const MESES_LARGOS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
export const formatDatePill = (date) => {
    if (!date) return '';
    const d = new Date(date);
    return `${d.getDate()} DE ${MESES_LARGOS[d.getMonth()]}, ${d.getFullYear()}`;
};

// Format relative time (e.g., "2 hours ago")
export const formatRelativeTime = (date) => {
    if (!date) return 'N/A';
    const now = new Date();
    const then = new Date(date);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Ahora mismo';
    if (diffMins < 60) return `Hace ${diffMins} minuto${diffMins > 1 ? 's' : ''}`;
    if (diffHours < 24) return `Hace ${diffHours} hora${diffHours > 1 ? 's' : ''}`;
    if (diffDays < 7) return `Hace ${diffDays} día${diffDays > 1 ? 's' : ''}`;
    return formatDate(date);
};

// Fecha y hora exacta en español, para el pie de cada mensaje/nota de la conversación.
export const formatExactTime = (date) => {
    if (!date) return '';
    const d = new Date(date);
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    let hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `El ${day}/${month}/${year} a las ${hours}:${minutes} ${ampm}`;
};

// Generate unique ID
export const generateId = () => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// Generate consecutive ID with prefix (e.g., TKT-0001, CARD-0001)
export const generateConsecutiveId = (prefix) => {
    const counterKey = `tms_${prefix.toLowerCase()}_counter`;
    let counter = parseInt(localStorage.getItem(counterKey) || '0', 10);
    counter += 1;
    localStorage.setItem(counterKey, counter.toString());
    return `${prefix}-${counter.toString().padStart(4, '0')}`;
};

// Export data to JSON
export const exportToJSON = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
};

// Export data to CSV
export const exportToCSV = (data, filename) => {
    if (!data || data.length === 0) return;

    const headers = Object.keys(data[0]);
    const csvContent = [
        headers.join(','),
        ...data.map(row => headers.map(header => {
            const value = row[header] || '';
            return typeof value === 'string' && value.includes(',')
                ? `"${value}"`
                : value;
        }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
};

// Calculate percentage
export const calculatePercentage = (value, total) => {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
};

// Get priority color
export const getPriorityColor = (priority) => {
    const colors = {
        low: 'var(--color-priority-low)',
        medium: 'var(--color-priority-medium)',
        high: 'var(--color-priority-high)',
        urgent: 'var(--color-priority-urgent)',
    };
    return colors[priority.toLowerCase()] || 'var(--color-text-muted)';
};

// Get status color
export const getStatusColor = (status) => {
    const colors = {
        new: 'var(--color-info)',
        'in progress': 'var(--color-warning)',
        resolved: 'var(--color-success)',
        closed: 'var(--color-text-muted)',
    };
    return colors[status.toLowerCase()] || 'var(--color-text-muted)';
};

// Truncate text
export const truncate = (text, length = 50) => {
    if (!text) return '';
    return text.length > length ? `${text.substring(0, length)}...` : text;
};

// Format a date-only value (YYYY-MM-DD) without time, e.g. "12 ago 2026"
export const formatDateShort = (date) => {
    if (!date) return null;
    // Evita corrimiento de zona horaria para valores DATEONLY tipo "2026-08-12"
    const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00`)
        : new Date(date);
    return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' });
};

// Cuenta días hábiles (lunes a viernes) entre dos fechas, inclusive de ambos extremos.
// Ej: mismo día lunes -> 1. Lunes a viernes -> 5. Sábado a domingo -> 0.
export const businessDaysBetween = (startDate, endDate) => {
    if (!startDate || !endDate) return null;
    const start = new Date(typeof startDate === 'string' ? `${startDate}T00:00:00` : startDate);
    const end = new Date(typeof endDate === 'string' ? `${endDate}T00:00:00` : endDate);
    if (isNaN(start) || isNaN(end)) return null;
    const [from, to] = start <= end ? [start, end] : [end, start];
    let count = 0;
    const cursor = new Date(from);
    while (cursor <= to) {
        const day = cursor.getDay();
        if (day !== 0 && day !== 6) count += 1;
        cursor.setDate(cursor.getDate() + 1);
    }
    return start <= end ? count : -count;
};

// Duración legible entre dos momentos (para "tiempo en proceso" en previews de tabla/tablero)
export const formatDuration = (startDate, endDate = new Date()) => {
    if (!startDate) return null;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = Math.max(0, end - start);
    const diffMins = Math.floor(diffMs / 60000);
    const days = Math.floor(diffMins / 1440);
    const hours = Math.floor((diffMins % 1440) / 60);
    const mins = diffMins % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
};

// Group items by key
export const groupBy = (array, key) => {
    return array.reduce((result, item) => {
        const group = item[key];
        if (!result[group]) {
            result[group] = [];
        }
        result[group].push(item);
        return result;
    }, {});
};
