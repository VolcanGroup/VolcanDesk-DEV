import React, { createContext, useState, useEffect } from 'react';

export const WorkspaceContext = createContext();

export const WorkspaceProvider = ({ children }) => {
    const [activeWorkspace, setActiveWorkspace] = useState('voltik');

    useEffect(() => {
        const stored = localStorage.getItem('tms_workspace');
        if (stored === 'voltik' || stored === 'volcan_desk') {
            setActiveWorkspace(stored);
        }
    }, []);

    const changeWorkspace = (workspace) => {
        if (workspace === 'voltik' || workspace === 'volcan_desk') {
            setActiveWorkspace(workspace);
            localStorage.setItem('tms_workspace', workspace);
        }
    };

    return (
        <WorkspaceContext.Provider value={{ activeWorkspace, changeWorkspace }}>
            {children}
        </WorkspaceContext.Provider>
    );
};
