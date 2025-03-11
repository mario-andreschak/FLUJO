// "use client";

// import React, { useState, useEffect } from 'react';
// import {
//   Dialog,
//   DialogTitle,
//   DialogContent,
//   DialogActions,
//   TextField,
//   Button,
//   Alert,
// } from '@mui/material';
// import { v4 as uuidv4 } from 'uuid';
// import { Model } from '@/types';
// import { modelService } from '@/services/model';

// export interface ModelFormProps {
//   open: boolean;
//   model: Model | null;
//   onSave: (model: Model) => void;
//   onClose: () => void;
// }

// export const ModelForm = ({ open, model, onSave, onClose }: ModelFormProps) => {
//   const [name, setName] = useState('');
//   const [description, setDescription] = useState('');
//   const [apiKey, setApiKey] = useState('');
//   const [baseUrl, setBaseUrl] = useState('');
//   const [nameError, setNameError] = useState('');
//   const [error, setError] = useState<string | null>(null);
//   const [info, setInfo] = useState<string | null>(null);

//   useEffect(() => {
//     const loadModel = async () => {
//       if (model) {
//         setName(model.name);
//         setDescription(model.description || '');
//         setBaseUrl(model.baseUrl || '');
        
//         try {
//           const decryptedKey = await modelService.decryptApiKey(model.encryptedApiKey);
//           if (decryptedKey) {
//             setApiKey(decryptedKey);
//           } else {
//             setApiKey(model.encryptedApiKey);
//             //setError('Failed to decrypt API key. Please re-enter it.');
//           }
//         } catch (error) {
//           console.error('Failed to decrypt API key:', error);
//           setApiKey('');
//           setError('Failed to decrypt API key. Please re-enter it.');
//         }
//       } else {
//         setName('');
//         setDescription('');
//         setApiKey('');
//         setBaseUrl('');
//         setError(null);
//         setInfo(null);
//       }
//     };
//     loadModel();
//   }, [model]);

//   const handleSubmit = async (e: React.FormEvent) => {
//     e.preventDefault();
//     setError(null);
//     setInfo(null);

//     // Basic validation
//     if (!name.trim()) {
//       setNameError('Name is required');
//       return;
//     }

//     if (!apiKey.trim()) {
//       setError('API key is required');
//       return;
//     }

//     let encryptedApiKey = await modelService.encryptApiKey(apiKey);
//     if (!encryptedApiKey) {
//       setInfo('Warning: No encryption key is set. The API key will be stored in plain text.');
//       encryptedApiKey = apiKey;
//     }

//     try {
//       onSave({
//         id: model?.id || uuidv4(),
//         name,
//         description: description || undefined,
//         encryptedApiKey,
//         baseUrl: baseUrl || undefined,
//       });
//     } catch (error) {
//       console.error('Failed to save model:', error);
//       setError(error instanceof Error ? error.message : 'Failed to save model');
//     }
//   };

//   return (
//     <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
//       <form onSubmit={handleSubmit}>
//         <DialogTitle>{model ? 'Edit Model' : 'Add Model'}</DialogTitle>
//         <DialogContent>
//           {error && (
//             <Alert severity="error" sx={{ mb: 2 }}>
//               {error}
//             </Alert>
//           )}
//           {info && (
//             <Alert severity="info" sx={{ mb: 2 }}>
//               {info}
//             </Alert>
//           )}
//           <TextField
//             autoFocus
//             margin="dense"
//             label="Name"
//             fullWidth
//             required
//             value={name}
//             onChange={(e) => {
//               setName(e.target.value);
//               setNameError('');
//             }}
//             error={!!nameError}
//             helperText={nameError}
//           />
//           <TextField
//             margin="dense"
//             label="Description"
//             fullWidth
//             multiline
//             rows={3}
//             value={description}
//             onChange={(e) => setDescription(e.target.value)}
//           />
//           <TextField
//             margin="dense"
//             label="API Key"
//             fullWidth
//             required
//             type="password"
//             value={apiKey}
//             onChange={(e) => setApiKey(e.target.value)}
//           />
//           <TextField
//             margin="dense"
//             label="Base URL (Optional)"
//             fullWidth
//             value={baseUrl}
//             onChange={(e) => setBaseUrl(e.target.value)}
//           />
//         </DialogContent>
//         <DialogActions>
//           <Button onClick={onClose}>Cancel</Button>
//           <Button type="submit" variant="contained" color="primary">
//             Save
//           </Button>
//         </DialogActions>
//       </form>
//     </Dialog>
//   );
// };

// export default ModelForm;

