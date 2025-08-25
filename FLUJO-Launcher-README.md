# FLUJO Launcher - Interactive Version

This is an interactive Windows launcher for FLUJO that allows users to selectively install/update dependencies and start the application with full control.

## What it does

The launcher provides:
1. 🔍 **Dependency Status Checking** - Shows current status and versions of all dependencies
2. ☑️ **Selective Installation** - Choose which components to install/update with checkboxes
3. 🚀 **Flexible Startup** - Start FLUJO regardless of dependency status (with warnings)
4. 🔄 **Update Management** - Check for and install updates to individual components
5. 📊 **Real-time Progress** - Visual progress tracking during operations
6. 📝 **Detailed Logging** - Complete installation and operation logs

## Key Features

### 🎯 **User-Controlled Installation**
- **No Automatic Installation**: User decides what to install/update
- **Selective Updates**: Check/uncheck individual dependencies
- **Flexible Startup**: Can start FLUJO even with missing dependencies
- **Status Awareness**: Clear visual indicators for each component

### 📋 **Dependency Management**
- **Git for Windows**: Detects version, offers installation/update
- **Node.js LTS**: Checks for Node.js and shows current version
- **Python 3.11**: Verifies Python installation and version
- **FLUJO Repository**: Clones or updates from GitHub
- **Build Status**: Checks if application is built and ready

### 🎨 **Professional Interface**
- **Clean GUI**: Modern Windows interface with progress tracking
- **Color-coded Status**: Green (✅), Red (❌), Orange (⚠️) indicators
- **Real-time Updates**: Status refreshes automatically
- **Progress Tracking**: Visual progress bars during operations
- **Detailed Logging**: View complete operation logs

## How to use

### 🚀 **Quick Start**
1. **Download** `FLUJO-Launcher.exe`
2. **Run** the launcher
3. **Click** "🔄 Refresh Status" to check dependencies
4. **Select** items you want to install/update (checkboxes)
5. **Click** "⚙️ Install/Update Selected" to install chosen items
6. **Click** "🚀 Start FLUJO" to launch the application

### 📊 **Understanding the Interface**

#### **Dependencies Status Section:**
```
☑️ Git for Windows          ✅ Installed (2.43.0)
☑️ Node.js LTS             ✅ Installed (v20.11.0)
☑️ Python 3.11             ❌ Not Installed
☑️ FLUJO Repository         ✅ Repository Found
☑️ Build Application        ⚠️ Not Built
```

#### **Action Buttons:**
- **🔄 Refresh Status**: Check current status of all dependencies
- **⚙️ Install/Update Selected**: Install/update checked items
- **🚀 Start FLUJO**: Launch FLUJO (works regardless of dependency status)

#### **Status Indicators:**
- **✅ Green**: Component is installed and working
- **❌ Red**: Component is missing or not installed
- **⚠️ Orange**: Component needs attention (e.g., not built)

## Installation Workflow

### 🔄 **Typical First-Time Setup:**
1. **Launch** → All dependencies show as ❌ Not Installed
2. **Auto-Select** → Missing dependencies are automatically checked
3. **Install** → Click "Install/Update Selected"
4. **Wait** → Progress bar shows installation progress
5. **Refresh** → Status updates automatically after installation
6. **Start** → Click "Start FLUJO" to launch

### 🔄 **Typical Update Workflow:**
1. **Launch** → Existing installations show as ✅ Installed
2. **Manual Select** → Check items you want to update
3. **Update** → Click "Install/Update Selected"
4. **Refresh** → Status updates with new versions
5. **Start** → Launch FLUJO with updated components

## Advanced Features

### ⚙️ **Settings**
- **Custom Install Directory**: Choose where FLUJO is installed
- **Default**: `%USERPROFILE%\FLUJO` (e.g., `C:\Users\YourName\FLUJO`)

### 📝 **Logging**
- **View Log**: Click to see detailed operation logs
- **Log Location**: `%TEMP%\FLUJO-Launcher\launcher.log`
- **Real-time Updates**: Log updates during operations

### 🔄 **Flexible Operation**
- **Partial Installation**: Install only what you need
- **Skip Dependencies**: Start FLUJO even with missing components
- **Update Individual Items**: Update Git without updating Node.js, etc.
- **Resume Operations**: Can retry failed installations

## Compilation Instructions

### **Option 1: Using AutoIt (Recommended)**
1. **Download AutoIt**: Get it from https://www.autoitscript.com/site/autoit/downloads/
2. **Install AutoIt**: Run the installer
3. **Compile**:
   - Right-click on `FLUJO-Launcher.au3`
   - Select "Compile Script (x64)"
   - Creates `FLUJO-Launcher.exe`

### **Option 2: Command Line**
```batch
"C:\Program Files (x86)\AutoIt3\Aut2Exe\Aut2exe.exe" /in "FLUJO-Launcher.au3" /out "FLUJO-Launcher.exe" /x64
```

## System Requirements

- **Windows 10 or later**
- **Internet connection** (for downloads)
- **~2GB free disk space**
- **Administrator privileges** (for installing dependencies)

## Troubleshooting

### 🔧 **Common Issues**

#### **"Failed to install [component]"**
- **Solution**: Run launcher as Administrator
- **Alternative**: Temporarily disable antivirus
- **Check**: View log for detailed error information

#### **"FLUJO failed to start"**
- **Check**: Port 4200 might be in use
- **Try**: Close other applications using port 4200
- **Manual**: Navigate to FLUJO directory and run `npm start`

#### **"No internet connection"**
- **Check**: Internet connectivity
- **Check**: Firewall/proxy settings
- **Alternative**: Use offline installers if available

#### **Dependencies show as "Not Installed" but they are**
- **Solution**: Click "🔄 Refresh Status"
- **Check**: PATH environment variables
- **Restart**: Launcher after installing dependencies

### 📋 **Status Meanings**

| Status | Meaning | Action |
|--------|---------|--------|
| ✅ Installed (version) | Working correctly | None needed |
| ❌ Not Installed | Missing component | Check box and install |
| ⚠️ Not Built | Needs building | Check "Build Application" |
| ⚠️ Update Available | Newer version exists | Check box to update |

## File Structure After Setup

```
%USERPROFILE%\FLUJO\
├── package.json          # Project configuration
├── next.config.ts        # Next.js configuration
├── src/                  # Source code
├── .next/               # Built application (after build)
├── node_modules/        # Dependencies (after npm install)
└── ...                  # Other project files
```

## Starting FLUJO Later

### **Using the Launcher (Recommended):**
1. Run `FLUJO-Launcher.exe`
2. Click "🚀 Start FLUJO"

### **Manual Method:**
```batch
cd %USERPROFILE%\FLUJO
npm start
```

### **Create Desktop Shortcut:**
1. Right-click on `FLUJO-Launcher.exe`
2. Select "Create shortcut"
3. Move shortcut to Desktop

## Key Differences from Installer Version

| Feature | Installer | Launcher |
|---------|-----------|----------|
| **User Control** | Automatic | Manual selection |
| **Startup** | Installs then starts | User decides when to start |
| **Updates** | All-or-nothing | Selective updates |
| **Flexibility** | Rigid workflow | Flexible operation |
| **Status** | One-time check | Continuous monitoring |
| **Dependencies** | Required for startup | Optional for startup |

## Security & Privacy

- **Official Sources**: Downloads from official repositories only
- **No Data Collection**: No telemetry or data transmission
- **Local Operation**: All operations performed locally
- **Open Source**: Full source code available for review

## Customization

Edit `FLUJO-Launcher.au3` to customize:
- **Installation Directory**: Modify `$INSTALL_DIR`
- **Download URLs**: Update `$GIT_URL`, `$NODE_URL`, `$PYTHON_URL`
- **Repository**: Change `$FLUJO_REPO`
- **UI Colors**: Modify color codes in GUI creation
- **Timeouts**: Adjust wait times for operations

## Distribution

The compiled `FLUJO-Launcher.exe`:
- **Size**: ~2-3MB
- **Dependencies**: None (self-contained)
- **Portability**: Can run from USB drive
- **Compatibility**: Windows 10+ (x64)

---

**FLUJO Launcher** - Giving users complete control over their FLUJO installation and management experience!
