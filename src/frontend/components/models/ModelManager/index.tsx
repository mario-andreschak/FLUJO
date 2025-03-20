import { Model } from '@/shared/types';
import { Box } from '@mui/material'
import { useCallback, useState, useEffect } from 'react'
import ModelList from './ModelList'
import ModelModal from './ModelModal'
import { modelService } from '@/frontend/services/model'

export default function ModelManager() {
  const [models, setModels] = useState<Model[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [currentModel, setCurrentModel] = useState<Model | null>(null)

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
      
      // Immediately open the model in edit mode if it was saved successfully
      if (result.model) {
        setCurrentModel(result.model)
        setModalOpen(true)
      }
    }
  }, [])

  const handleUpdate = useCallback(async (model: Model) => {
    // Open the model modal for editing
    setCurrentModel(model)
    setModalOpen(true)
  }, [])

  const handleSave = useCallback(async (model: Model) => {
    const result = await modelService.updateModel(model)
    if (result.success) {
      // Refresh models after updating
      const updatedModels = await modelService.loadModels()
      setModels(updatedModels)
      // Close the modal
      setModalOpen(false)
      setCurrentModel(null)
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

  const handleCloseModal = useCallback(() => {
    setModalOpen(false)
    setCurrentModel(null)
  }, [])

  return (
    <Box>
      <ModelList
        models={models}
        isLoading={isLoading}
        onAdd={() => {
          setCurrentModel(null)
          setModalOpen(true)
        }}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
      <ModelModal
        open={modalOpen}
        model={currentModel}
        onSave={handleSave}
        onClose={handleCloseModal}
      />
    </Box>
  )
}

// Export components for direct imports
export { default as ModelCard } from './ModelCard'
export { default as ModelModal } from './ModelModal'
export { default as ModelList } from './ModelList'
