import { generateId } from '../utils/helpers';

// Convert file to base64
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
};

// Add attachment to an entity (ticket or card)
export const createAttachment = async (file, userId) => {
    try {
        // Validate file size (warn if > 1MB due to localStorage limits)
        const maxSize = 1024 * 1024; // 1MB
        if (file.size > maxSize) {
            console.warn(`File size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds recommended limit of 1MB`);
        }

        const fileData = await fileToBase64(file);

        return {
            id: generateId(),
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            fileData: fileData,
            uploadedBy: userId,
            uploadedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('Error creating attachment:', error);
        return null;
    }
};

// Download attachment
export const downloadAttachment = (attachment) => {
    try {
        const link = document.createElement('a');
        link.href = attachment.fileData;
        link.download = attachment.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        console.error('Error downloading attachment:', error);
    }
};

// Get file icon based on file type
export const getFileIcon = (fileType) => {
    if (!fileType) return '📄';

    if (fileType.startsWith('image/')) return '🖼️';
    if (fileType.startsWith('video/')) return '🎥';
    if (fileType.startsWith('audio/')) return '🎵';
    if (fileType.includes('pdf')) return '📕';
    if (fileType.includes('word') || fileType.includes('document')) return '📘';
    if (fileType.includes('sheet') || fileType.includes('excel')) return '📊';
    if (fileType.includes('presentation') || fileType.includes('powerpoint')) return '📽️';
    if (fileType.includes('zip') || fileType.includes('rar') || fileType.includes('tar')) return '🗜️';
    if (fileType.includes('text')) return '📝';

    return '📄';
};

// Format file size
export const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

// Check if file is an image that can be previewed
export const canPreviewImage = (fileType) => {
    return fileType && fileType.startsWith('image/');
};
