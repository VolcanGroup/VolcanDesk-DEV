import { api } from './api';

// --- Catálogo de Campos ---
export const getCamposCatalogo = async () => {
    return await api.get('/campos-catalogo');
};

export const createCampoCatalogo = async (data) => {
    return await api.post('/campos-catalogo', data);
};

export const updateCampoCatalogo = async (id, data) => {
    return await api.put(`/campos-catalogo/${id}`, data);
};

export const deleteCampoCatalogo = async (id) => {
    return await api.delete(`/campos-catalogo/${id}`);
};

// --- Reglas de Flujo ---
export const getReglasFlujo = async () => {
    return await api.get('/reglas-flujo');
};

export const createReglaFlujo = async (data) => {
    return await api.post('/reglas-flujo', data);
};

export const updateReglaFlujo = async (id, data) => {
    return await api.put(`/reglas-flujo/${id}`, data);
};

export const deleteReglaFlujo = async (id) => {
    return await api.delete(`/reglas-flujo/${id}`);
};

export const resolveReglaFlujo = async (tipoId, categoriaId) => {
    let url = `/reglas-flujo/resolve?tipo_id=${encodeURIComponent(tipoId)}`;
    if (categoriaId) {
        url += `&categoria_id=${encodeURIComponent(categoriaId)}`;
    }
    return await api.get(url);
};
