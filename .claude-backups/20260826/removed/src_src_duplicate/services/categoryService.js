// Category Service - Gestión de categorías de tickets
import { generateId } from '../utils/helpers';

const STORAGE_KEY = 'tms_categories';

// Categorías predefinidas
const defaultCategories = [
    {
        id: '1',
        name: 'Técnico',
        description: 'Problemas técnicos y errores del sistema',
        color: '#3B82F6',
        icon: '🔧',
        createdAt: new Date().toISOString()
    },
    {
        id: '2',
        name: 'Soporte',
        description: 'Consultas y ayuda general',
        color: '#10B981',
        icon: '💬',
        createdAt: new Date().toISOString()
    },
    {
        id: '3',
        name: 'Ventas',
        description: 'Consultas comerciales y ventas',
        color: '#8B5CF6',
        icon: '💰',
        createdAt: new Date().toISOString()
    },
    {
        id: '4',
        name: 'Facturación',
        description: 'Temas de facturación y pagos',
        color: '#F59E0B',
        icon: '🧾',
        createdAt: new Date().toISOString()
    },
    {
        id: '5',
        name: 'Otros',
        description: 'Otros temas no categorizados',
        color: '#6B7280',
        icon: '📋',
        createdAt: new Date().toISOString()
    }
];

// Initialize categories
const initializeCategories = () => {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (!existing) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultCategories));
        return defaultCategories;
    }
    return JSON.parse(existing);
};

// Get all categories
export const getCategories = () => {
    return initializeCategories();
};

// Get category by ID
export const getCategoryById = (id) => {
    const categories = getCategories();
    return categories.find(cat => cat.id === id);
};

// Create category (Admin only)
export const createCategory = (categoryData) => {
    const categories = getCategories();
    const newCategory = {
        id: generateId(),
        ...categoryData,
        createdAt: new Date().toISOString()
    };
    categories.push(newCategory);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(categories));
    return newCategory;
};

// Update category (Admin only)
export const updateCategory = (id, updates) => {
    const categories = getCategories();
    const index = categories.findIndex(cat => cat.id === id);
    if (index !== -1) {
        categories[index] = {
            ...categories[index],
            ...updates,
            updatedAt: new Date().toISOString()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(categories));
        return categories[index];
    }
    return null;
};

// Delete category (Admin only)
export const deleteCategory = (id) => {
    const categories = getCategories();
    const filtered = categories.filter(cat => cat.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    return true;
};

// Get category name
export const getCategoryName = (categoryId) => {
    if (!categoryId) return 'Sin categoría';
    const category = getCategoryById(categoryId);
    return category ? category.name : 'Sin categoría';
};

// Get category color
export const getCategoryColor = (categoryId) => {
    if (!categoryId) return '#6B7280';
    const category = getCategoryById(categoryId);
    return category ? category.color : '#6B7280';
};
