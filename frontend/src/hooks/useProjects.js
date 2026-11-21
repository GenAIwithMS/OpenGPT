import { useEffect, useState } from 'react';
import { projectService } from '../services/api';

/**
 * The sidebar's project list.
 *
 * @returns {{projects: {id: string, name: string, instructions: string, chats: number}[],
 *   fetchProjects: Function, createProject: (name: string) => Promise<object>}}
 */
export const useProjects = () => {
  const [projects, setProjects] = useState([]);

  const fetchProjects = async () => {
    try {
      setProjects(await projectService.list());
    } catch (err) {
      console.error('Error fetching projects:', err);
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const createProject = async (name) => {
    const project = await projectService.create(name);
    await fetchProjects();
    return project;
  };

  return { projects, fetchProjects, createProject };
};
