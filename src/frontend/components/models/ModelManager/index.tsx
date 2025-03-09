import { Model } from '@/shared/types';
import { Box } from '@mui/material'
import { useCallback, useState, useEffect } from 'react'
import ModelList from './ModelList'
import { modelService } from '@/shared/services/model/model.frontend'

export default function ModelManager() {
  const [models, setModels] = useState<Model[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load models on component mount
  useEffect(() => {
    const loadModels = async () => {
      setIsLoading(true)
      const loadedModels = await modelService.loadModels()
      setModels(loadedModels)
      setIsLoading(false)
    }
    
    loadModels()
  }, [])

  const handleAdd = useCallback(async (model: Model) => {
    const result = await modelService.addModel(model)
    if (result.success) {
      // Refresh models after adding
      const updatedModels = await modelService.loadModels()
      setModels(updatedModels)
    }
  }, [])

  const handleUpdate = useCallback(async (model: Model) => {
    const result = await modelService.updateModel(model)
    if (result.success) {
      // Refresh models after updating
      const updatedModels = await modelService.loadModels()
      setModels(updatedModels)
    }
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    const result = await modelService.deleteModel(id)
    if (result.success) {
      // Refresh models after deleting
      const updatedModels = await modelService.loadModels()
      setModels(updatedModels)
    }
  }, [])

  return (
    <Box>
      <ModelList
        models={models}
        isLoading={isLoading}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </Box>
  )
}

// Export components for direct imports
export { default as ModelCard } from './ModelCard'
export { default as ModelModal } from './ModelModal'
export { default as ModelList } from './ModelList'
