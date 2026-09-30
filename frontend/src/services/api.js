// En local (npm run dev) window.location.hostname es 'localhost', así que esto
// se comporta exactamente igual que antes. Al desplegar en un servidor y
// entrar desde otra máquina por IP interna, 'localhost' apuntaría a la propia
// máquina del usuario, no al servidor — usamos el hostname con el que
// realmente se cargó la página para que el API_BASE_URL siempre apunte al
// mismo servidor, sin necesidad de reconfigurar nada por ambiente.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
    || `${window.location.protocol}//${window.location.hostname}:4000/api`;

// Origen del servidor (sin el sufijo /api) — usado para construir URLs absolutas
// hacia archivos servidos estáticamente en /api/uploads/... (ver processAttachments
// en server.js y el campo dinámico tipo "archivo").
export const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');

export const request = async (endpoint, options = {}) => {
    const url = `${API_BASE_URL}${endpoint}`;
    
    const currentUserRaw = localStorage.getItem('tms_current_user');
    let currentUser = null;
    try {
        if (currentUserRaw) currentUser = JSON.parse(currentUserRaw);
    } catch(e){}

    // Set headers
    const headers = {
        'Content-Type': 'application/json',
        'x-user-id': currentUser?.id || '',
        'x-user-role': currentUser?.role || '',
        ...options.headers,
    };
    
    const config = {
        ...options,
        headers,
    };
    
    try {
        const response = await fetch(url, config);
        
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(errorBody.error || `HTTP error! status: ${response.status}`);
        }
        
        // Handle no content (like 204 or delete success)
        if (response.status === 204) return null;
        
        return await response.json();
    } catch (error) {
        console.error(`API Request Error [${endpoint}]:`, error);
        throw error;
    }
};

export const api = {
    get: (endpoint, options) => request(endpoint, { ...options, method: 'GET' }),
    post: (endpoint, data, options) => request(endpoint, { ...options, method: 'POST', body: JSON.stringify(data) }),
    put: (endpoint, data, options) => request(endpoint, { ...options, method: 'PUT', body: JSON.stringify(data) }),
    delete: (endpoint, options) => request(endpoint, { ...options, method: 'DELETE' }),
};
