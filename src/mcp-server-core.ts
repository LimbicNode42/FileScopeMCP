import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { 
  FileNode, 
  ToolResponse, 
  FileTreeConfig,
  FileWatchingConfig
} from "./types.js";
import { scanDirectory, calculateImportance, setFileImportance, buildDependentMap, normalizePath, addFileNode, removeFileNode, excludeAndRemoveFile } from "./file-utils.js";
import { 
  createFileTreeConfig, 
  saveFileTree,
  loadFileTree,
  listSavedFileTrees,
  updateFileNode,
  getFileNode,
  normalizeAndResolvePath
} from "./storage-utils.js";
import { MermaidGenerator } from "./mermaid-generator.js";
import { setProjectRoot, getProjectRoot, setConfig, getConfig } from './global-state.js';
import { loadConfig, saveConfig } from './config-utils.js';
import { FileWatcher, FileEventType } from './file-watcher.js';
import { log, enableFileLogging } from './logger.js';

// Server state - these will be shared across transports
let fileTree: FileNode | null = null;
let currentConfig: FileTreeConfig | null = null;
let fileWatcher: FileWatcher | null = null;
const fileEventDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_DURATION_MS = 2000; // 2 seconds

// Helper function to create MCP responses
function createMcpResponse(content: any, isError = false): ToolResponse {
  let formattedContent;
  
  if (Array.isArray(content) && content.every(item => 
    typeof item === 'object' && 
    ('type' in item) && 
    (item.type === 'text' || item.type === 'image' || item.type === 'resource'))) {
    formattedContent = content;
  } else if (Array.isArray(content)) {
    formattedContent = content.map(item => ({
      type: "text",
      text: typeof item === 'string' ? item : JSON.stringify(item, null, 2)
    }));
  } else if (typeof content === 'string') {
    formattedContent = [{
      type: "text",
      text: content
    }];
  } else {
    formattedContent = [{
      type: "text",
      text: typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content)
    }];
  }

  return {
    content: formattedContent,
    isError
  };
}

/**
 * Centralized function to initialize or re-initialize the project analysis.
 */
async function initializeProject(projectPath: string): Promise<ToolResponse> {
  const projectRoot = normalizeAndResolvePath(projectPath);
  log(`Initializing project at: ${projectRoot}`);

  try {
    await fs.access(projectRoot);
  } catch (error) {
    return createMcpResponse(`Error: Directory not found at ${projectRoot}`, true);
  }

  setProjectRoot(projectRoot);
  process.chdir(projectRoot);
  log('Changed working directory to: ' + process.cwd());

  let config = getConfig();
  if (config) {
    config.baseDirectory = projectRoot;
    setConfig(config);
  }

  const newConfig: FileTreeConfig = {
    filename: `FileScopeMCP-tree-${path.basename(projectRoot)}.json`,
    baseDirectory: projectRoot,
    projectRoot: projectRoot,
    lastUpdated: new Date()
  };

  try {
    await buildFileTree(newConfig);
    
    const fileWatchingConfig = getConfig()?.fileWatching;
    if (fileWatchingConfig?.enabled) {
      log('File watching is enabled, initializing watcher...');
      await initializeFileWatcher();
    }

    return createMcpResponse(`Project path set to ${projectRoot}. File tree built and saved to ${newConfig.filename}.`);
  } catch (error) {
    log("Failed to build file tree: " + error);
    return createMcpResponse(`Failed to build file tree for ${projectRoot}: ${error}`, true);
  }
}

// Additional helper functions (keeping them minimal for now)
async function buildFileTree(config: FileTreeConfig): Promise<FileNode> {
  // Simplified version - full implementation in the original file
  log('Building file tree for: ' + config.baseDirectory);
  
  try {
    const savedTree = await loadFileTree(config.filename);
    if (savedTree?.fileTree) {
      fileTree = savedTree.fileTree;
      currentConfig = savedTree.config;
      return fileTree;
    }
  } catch (error) {
    log('Failed to load existing file tree: ' + error);
  }

  if (!getConfig()) {
    const currentConfig = await loadConfig();
    setConfig(currentConfig);
  }
  
  fileTree = await scanDirectory(config.baseDirectory);
  buildDependentMap(fileTree);
  calculateImportance(fileTree);
  
  await saveFileTree(config, fileTree);
  currentConfig = config;
  
  return fileTree;
}

function isProjectPathSet(): boolean {
  return fileTree !== null;
}

async function initializeFileWatcher(): Promise<void> {
  // Simplified file watcher initialization
  if (fileWatcher) {
    fileWatcher.stop();
  }
  
  const config = getConfig()?.fileWatching;
  if (!config?.enabled) return;
  
  fileWatcher = new FileWatcher(config, getProjectRoot());
  fileWatcher.addEventCallback(handleFileEvent);
  fileWatcher.start();
  log('File watcher initialized');
}

async function handleFileEvent(filePath: string, eventType: FileEventType): Promise<void> {
  // Simplified file event handling
  log(`File event: ${eventType} for ${filePath}`);
  // Implementation would handle debouncing and tree updates
}

// Get all file nodes as a flat array
function getAllFileNodes(node: FileNode): FileNode[] {
  const results: FileNode[] = [];
  
  function traverse(currentNode: FileNode) {
    if (!currentNode.isDirectory) {
      results.push(currentNode);
    }
    
    if (currentNode.children && currentNode.children.length > 0) {
      for (const child of currentNode.children) {
        traverse(child);
      }
    }
  }
  
  // Start traversal with the root node
  traverse(node);
  return results;
}

// Utility functions
function findNode(node: FileNode, targetPath: string): FileNode | null {
  const normalizedTarget = normalizePath(targetPath);
  
  function traverse(currentNode: FileNode): FileNode | null {
    if (normalizePath(currentNode.path) === normalizedTarget) {
      return currentNode;
    }
    
    if (currentNode.children && currentNode.children.length > 0) {
      for (const child of currentNode.children) {
        const found = traverse(child);
        if (found) return found;
      }
    }
    
    return null;
  }
  
  return traverse(node);
}

// Read the content of a file
async function readFileContent(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }
}

/**
 * Creates and configures an MCP server instance with all tools registered
 */
export async function createMcpServerInstance(): Promise<McpServer> {
  // Enable file logging for debugging
  enableFileLogging(false, 'mcp-debug.log');

  log('Creating MCP server instance...');

  const serverInfo = {
    name: "FileScopeMCP",
    version: "1.0.0",
    description: "A tool for ranking files in your codebase by importance and providing summaries with dependency tracking"
  };

  const server = new McpServer(serverInfo, {
    capabilities: {
      tools: { listChanged: true }
    }
  });

  const projectPathNotSetError = createMcpResponse("Project path not set. Please call 'set_project_path' or initialize the server with --base-dir.", true);

  // Register all tools
  server.tool("set_project_path", "Sets the project directory to analyze", {
    path: z.string().describe("The absolute path to the project directory"),
  }, async (params: { path: string }) => {
    return await initializeProject(params.path);
  });

  server.tool("list_files", "List all files in the project with their importance rankings", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    return createMcpResponse(fileTree);
  });

  server.tool("get_file_importance", "Get the importance ranking of a specific file", {
    filepath: z.string().describe("The path to the file to check")
  }, async (params: { filepath: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    
    const normalizedPath = normalizePath(params.filepath);
    const node = getFileNode(fileTree!, normalizedPath);
    
    if (!node) {
      return createMcpResponse(`File not found: ${params.filepath}`, true);
    }
    
    return createMcpResponse({
      path: node.path,
      importance: node.importance || 0,
      dependencies: node.dependencies || [],
      dependents: node.dependents || [],
      summary: node.summary || null
    });
  });

  server.tool("read_file_content", "Read the content of a specific file", {
    filepath: z.string().describe("The path to the file to read")
  }, async (params: { filepath: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    try {
      const content = await fs.readFile(params.filepath, 'utf-8');
      return createMcpResponse(content);
    } catch (error) {
      return createMcpResponse(`Failed to read file: ${params.filepath} - ` + error, true);
    }
  });

  server.tool("list_saved_trees", "List all saved file trees", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    const trees = await listSavedFileTrees();
    return createMcpResponse(trees);
  });

  server.tool("delete_file_tree", "Delete a file tree configuration", {
    filename: z.string().describe("Name of the JSON file to delete")
  }, async (params: { filename: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    try {
      const normalizedPath = normalizeAndResolvePath(params.filename);
      await fs.unlink(normalizedPath);
      
      // Clear from memory if it's the current tree
      if (currentConfig?.filename === normalizedPath) {
        currentConfig = null;
        fileTree = null;
      }
      
      return createMcpResponse(`Successfully deleted ${normalizedPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createMcpResponse(`File tree ${params.filename} does not exist`);
      }
      return createMcpResponse(`Failed to delete ${params.filename}: ` + error, true);
    }
  });

  server.tool("create_file_tree", "Create or load a file tree configuration", {
    filename: z.string().describe("Name of the JSON file to store the file tree"),
    baseDirectory: z.string().describe("Base directory to scan for files")
  }, async (params: { filename: string, baseDirectory: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    log('Create file tree called with params: ' + JSON.stringify(params));
    log('Current working directory: ' + process.cwd());
    
    try {
      // Ensure we're using paths relative to the current directory
      const relativeFilename = path.isAbsolute(params.filename) 
        ? path.relative(process.cwd(), params.filename) 
        : params.filename;
      log('Relative filename: ' + relativeFilename);
      
      // Handle special case for current directory
      let baseDir = params.baseDirectory;
      if (baseDir === '.' || baseDir === './') {
        baseDir = getProjectRoot(); // Use the project root instead of cwd
        log('Resolved "." to project root: ' + baseDir);
      }
      
      // Normalize the base directory relative to project root if not absolute
      if (!path.isAbsolute(baseDir)) {
        baseDir = path.join(getProjectRoot(), baseDir);
        log('Resolved relative base directory: ' + baseDir);
      }
      
      const config = await createFileTreeConfig(relativeFilename, baseDir);
      log('Created config: ' + JSON.stringify(config));
      
      // Build the tree with the new config, not the default
      const tree = await buildFileTree(config);
      log('Built file tree with root path: ' + tree.path);
      
      // Update global state
      fileTree = tree;
      currentConfig = config;
      
      return createMcpResponse({
        message: `File tree created and stored in ${config.filename}`,
        config
      });
    } catch (error) {
      log('Error in create_file_tree: ' + error);
      return createMcpResponse(`Failed to create file tree: ` + error, true);
    }
  });

  server.tool("select_file_tree", "Select an existing file tree to work with", {
    filename: z.string().describe("Name of the JSON file containing the file tree")
  }, async (params: { filename: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    const storage = await loadFileTree(params.filename);
    if (!storage) {
      return createMcpResponse(`File tree not found: ${params.filename}`, true);
    }
    
    fileTree = storage.fileTree;
    currentConfig = storage.config;
    
    return createMcpResponse({
      message: `File tree loaded from ${params.filename}`,
      config: currentConfig
    });
  });

  server.tool("find_important_files", "Find the most important files in the project", {
    limit: z.number().optional().describe("Number of files to return (default: 10)"),
    minImportance: z.number().optional().describe("Minimum importance score (0-10)")
  }, async (params: { limit?: number, minImportance?: number }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    
    const limit = params.limit || 10;
    const minImportance = params.minImportance || 0;
    
    // Get all files as a flat array
    const allFiles = getAllFileNodes(fileTree!);
    
    // Filter by minimum importance and sort by importance (descending)
    const importantFiles = allFiles
      .filter(file => (file.importance || 0) >= minImportance)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, limit)
      .map(file => ({
        path: file.path,
        importance: file.importance || 0,
        dependentCount: file.dependents?.length || 0,
        dependencyCount: file.dependencies?.length || 0,
        hasSummary: !!file.summary
      }));
    
    return createMcpResponse(importantFiles);
  });

  server.tool("get_file_summary", "Get the summary of a specific file", {
    filepath: z.string().describe("The path to the file to check")
  }, async (params: { filepath: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    
    const normalizedPath = normalizePath(params.filepath);
    const node = getFileNode(fileTree!, normalizedPath);
    
    if (!node) {
      return createMcpResponse(`File not found: ${params.filepath}`, true);
    }
    
    if (!node.summary) {
      return createMcpResponse(`No summary available for ${params.filepath}`);
    }
    
    return createMcpResponse({
      path: node.path,
      summary: node.summary
    });
  });

  server.tool("set_file_summary", "Set the summary of a specific file", {
    filepath: z.string().describe("The path to the file to update"),
    summary: z.string().describe("The summary text to set")
  }, async (params: { filepath: string, summary: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    
    const normalizedPath = normalizePath(params.filepath);
    const updated = updateFileNode(fileTree!, normalizedPath, {
      summary: params.summary
    });
    
    if (!updated) {
      return createMcpResponse(`File not found: ${params.filepath}`, true);
    }
    
    // Save the updated tree
    await saveFileTree(currentConfig!, fileTree!);
    
    return createMcpResponse({
      message: `Summary updated for ${params.filepath}`,
      path: normalizedPath,
      summary: params.summary
    });
  });

  server.tool("set_file_importance", "Manually set the importance ranking of a specific file", {
    filepath: z.string().describe("The path to the file to update"),
    importance: z.number().min(0).max(10).describe("The importance value to set (0-10)")
  }, async (params: { filepath: string, importance: number }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    try {
      log('set_file_importance called with params: ' + JSON.stringify(params));
      log('Current file tree root: ' + fileTree?.path);
      
      // Get a list of all files
      const allFiles = getAllFileNodes(fileTree!);
      log(`Total files in tree: ${allFiles.length}`);
      
      // First try the findAndSetImportance method
      const wasUpdated = setFileImportance(fileTree!, params.filepath, params.importance);
      
      // If that didn't work, try matching by basename
      if (!wasUpdated) {
        const basename = path.basename(params.filepath);
        log(`Looking for file with basename: ${basename}`);
        
        let foundFile = false;
        for (const file of allFiles) {
          const fileBasename = path.basename(file.path);
          log(`Checking file: ${file.path} with basename: ${fileBasename}`);
          
          if (fileBasename === basename) {
            log(`Found match: ${file.path}`);
            file.importance = Math.min(10, Math.max(0, params.importance));
            foundFile = true;
            break;
          }
        }
        
        if (!foundFile) {
          log('File not found by any method');
          return createMcpResponse(`File not found: ${params.filepath}`, true);
        }
      }
      
      // Save the updated tree
      await saveFileTree(currentConfig!, fileTree!);
      
      return createMcpResponse({
        message: `Importance updated for ${params.filepath}`,
        path: params.filepath,
        importance: params.importance
      });
    } catch (error) {
      log('Error in set_file_importance: ' + error);
      return createMcpResponse(`Failed to set file importance: ` + error, true);
    }
  });

  server.tool("recalculate_importance", "Recalculate importance values for all files based on dependencies", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;

    log('Recalculating importance values...');
    buildDependentMap(fileTree!);
    calculateImportance(fileTree!);
    
    // Save the updated tree
    if (currentConfig) {
      await saveFileTree(currentConfig, fileTree!);
    }
    
    // Count files with non-zero importance
    const allFiles = getAllFileNodes(fileTree!);
    const filesWithImportance = allFiles.filter(file => (file.importance || 0) > 0);
    
    return createMcpResponse({
      message: "Importance values recalculated",
      totalFiles: allFiles.length,
      filesWithImportance: filesWithImportance.length
    });
  });

  server.tool("toggle_file_watching", "Toggle file watching on/off", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    const config = getConfig();
    if (!config) {
      return createMcpResponse('No configuration loaded', true);
    }
    
    // Create default file watching config if it doesn't exist
    if (!config.fileWatching) {
      config.fileWatching = {
        enabled: true,
        debounceMs: 300,
        ignoreDotFiles: true,
        autoRebuildTree: true,
        maxWatchedDirectories: 1000,
        watchForNewFiles: true,
        watchForDeleted: true,
        watchForChanged: true
      };
    } else {
      // Toggle the enabled status
      config.fileWatching.enabled = !config.fileWatching.enabled;
    }
    
    // Save the updated config
    setConfig(config);
    await saveConfig(config);
    
    if (config.fileWatching.enabled) {
      // Start watching
      await initializeFileWatcher();
      return createMcpResponse('File watching enabled');
    } else {
      // Stop watching
      if (fileWatcher) {
        fileWatcher.stop();
        fileWatcher = null;
      }
      return createMcpResponse('File watching disabled');
    }
  });

  server.tool("get_file_watching_status", "Get the current status of file watching", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    const config = getConfig();
    const status = {
      enabled: config?.fileWatching?.enabled || false,
      isActive: fileWatcher !== null && fileWatcher !== undefined,
      config: config?.fileWatching || null
    };
    
    return createMcpResponse(status);
  });

  server.tool("update_file_watching_config", "Update file watching configuration", {
    config: z.object({
      enabled: z.boolean().optional(),
      debounceMs: z.number().int().positive().optional(),
      ignoreDotFiles: z.boolean().optional(),
      autoRebuildTree: z.boolean().optional(),
      maxWatchedDirectories: z.number().int().positive().optional(),
      watchForNewFiles: z.boolean().optional(),
      watchForDeleted: z.boolean().optional(),
      watchForChanged: z.boolean().optional()
    }).describe("File watching configuration options")
  }, async (params: { config: Partial<FileWatchingConfig> }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    const config = getConfig();
    if (!config) {
      return createMcpResponse('No configuration loaded', true);
    }
    
    // Create or update file watching config
    if (!config.fileWatching) {
      config.fileWatching = {
        enabled: false,
        debounceMs: 300,
        ignoreDotFiles: true,
        autoRebuildTree: true,
        maxWatchedDirectories: 1000,
        watchForNewFiles: true,
        watchForDeleted: true,
        watchForChanged: true,
        ...params.config
      };
    } else {
      config.fileWatching = {
        ...config.fileWatching,
        ...params.config
      };
    }
    
    // Save the updated config
    setConfig(config);
    await saveConfig(config);
    
    // Restart watcher if it's enabled
    if (config.fileWatching.enabled) {
      await initializeFileWatcher();
    } else if (fileWatcher) {
      fileWatcher.stop();
      fileWatcher = null;
    }
    
    return createMcpResponse({
      message: 'File watching configuration updated',
      config: config.fileWatching
    });
  });

  server.tool("debug_list_all_files", "List all file paths in the current file tree", async () => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    
    // Get a flat list of all files
    const allFiles = getAllFileNodes(fileTree!);
    
    // Extract just the paths and basenames
    const fileDetails = allFiles.map(file => ({
      path: file.path,
      basename: path.basename(file.path),
      importance: file.importance || 0
    }));
    
    return createMcpResponse({
      totalFiles: fileDetails.length,
      files: fileDetails
    });
  });

  server.tool("generate_diagram", "Generate a Mermaid diagram for the current file tree", {
    style: z.enum(['default', 'dependency', 'directory', 'hybrid', 'package-deps']).describe('Diagram style'),
    maxDepth: z.number().optional().describe('Maximum depth for directory trees (1-10)'),
    minImportance: z.number().optional().describe('Only show files above this importance (0-10)'),
    showDependencies: z.boolean().optional().describe('Whether to show dependency relationships'),
    showPackageDeps: z.boolean().optional().describe('Whether to show package dependencies'),
    packageGrouping: z.boolean().optional().describe('Whether to group packages by scope'),
    autoGroupThreshold: z.number().optional().describe("Auto-group nodes when parent has more than this many direct children (default: 8)"),
    excludePackages: z.array(z.string()).optional().describe('Packages to exclude from diagram'),
    includeOnlyPackages: z.array(z.string()).optional().describe('Only include these packages (if specified)'),
    outputPath: z.string().optional().describe('Full path or relative path where to save the diagram file (.mmd)'),
    outputFormat: z.enum(['mmd']).optional().describe('Output format (mmd)'),
    layout: z.object({
      direction: z.enum(['TB', 'BT', 'LR', 'RL']).optional().describe("Graph direction"),
      rankSpacing: z.number().min(10).max(100).optional().describe("Space between ranks"),
      nodeSpacing: z.number().min(10).max(100).optional().describe("Space between nodes")
    }).optional()
  }, async (params: {
    style: 'default' | 'dependency' | 'directory' | 'hybrid' | 'package-deps';
    maxDepth?: number;
    minImportance?: number;
    showDependencies?: boolean;
    showPackageDeps?: boolean;
    packageGrouping?: boolean;
    autoGroupThreshold?: number;
    excludePackages?: string[];
    includeOnlyPackages?: string[];
    outputPath?: string;
    outputFormat?: 'mmd';
    layout?: {
      direction?: 'TB' | 'BT' | 'LR' | 'RL';
      rankSpacing?: number;
      nodeSpacing?: number;
    };
  }) => {
    try {
      if (!fileTree) {
        return createMcpResponse("No file tree loaded. Please create or select a file tree first.", true);
      }

      // Use specialized config for package-deps style
      if (params.style === 'package-deps') {
        // Package-deps style should show package dependencies by default
        params.showPackageDeps = params.showPackageDeps ?? true;
        // Default to left-to-right layout for better readability of packages
        if (!params.layout) {
          params.layout = { direction: 'LR' };
        } else if (!params.layout.direction) {
          params.layout.direction = 'LR';
        }
      }

      // Generate the diagram with added autoGroupThreshold parameter
      const generator = new MermaidGenerator(fileTree, {
        style: params.style,
        maxDepth: params.maxDepth,
        minImportance: params.minImportance,
        showDependencies: params.showDependencies,
        showPackageDeps: params.showPackageDeps,
        packageGrouping: params.packageGrouping,
        autoGroupThreshold: params.autoGroupThreshold,
        excludePackages: params.excludePackages,
        includeOnlyPackages: params.includeOnlyPackages,
        layout: params.layout
      });
      const diagram = generator.generate();
      const mermaidContent = diagram.code;

      // Save diagram to file if requested
      if (params.outputPath) {
        const outputFormat = params.outputFormat || 'mmd';
        const baseOutputPath = path.resolve(process.cwd(), params.outputPath);
        const outputDir = path.dirname(baseOutputPath);
        
        log(`Attempting to save diagram file to: ${baseOutputPath}`);
        
        // Ensure output directory exists
        try {
          await fs.mkdir(outputDir, { recursive: true });
          log(`Created output directory: ${outputDir}`);
        } catch (err: any) {
          if (err.code !== 'EEXIST') {
            log(`Error creating output directory: ` + err);
            return createMcpResponse(`Failed to create output directory: ${err.message}`, true);
          }
        }

        // Save the Mermaid file
        const mmdPath = baseOutputPath.endsWith('.mmd') ? baseOutputPath : baseOutputPath + '.mmd';
        try {
          await fs.writeFile(mmdPath, mermaidContent, 'utf8');
          log(`Successfully saved Mermaid file to: ${mmdPath}`);
          
          return createMcpResponse({
            message: `Successfully generated diagram in mmd format`,
            filePath: mmdPath,
            stats: diagram.stats
          });
        } catch (err: any) {
          log(`Error saving Mermaid file: ` + err);
          return createMcpResponse(`Failed to save Mermaid file: ${err.message}`, true);
        }
      }

      // Return both the diagram content and file information
      return createMcpResponse([
        {
          type: "text",
          text: JSON.stringify({
            stats: diagram.stats,
            style: diagram.style,
            generated: diagram.timestamp
          }, null, 2)
        },
        {
          type: "resource" as const,
          resource: {
            uri: 'data:text/x-mermaid;base64,' + Buffer.from(mermaidContent).toString('base64'),
            text: mermaidContent,
            mimeType: "text/x-mermaid"
          }
        }
      ]);
    } catch (error) {
      log('Error generating diagram: ' + error);
      return createMcpResponse(`Failed to generate diagram: ` + error, true);
    }
  });

  server.tool("exclude_and_remove", "Exclude and remove a file or pattern from the file tree", {
    filepath: z.string().describe("The path or pattern of the file to exclude and remove")
  }, async (params: { filepath: string }) => {
    try {
      if (!fileTree || !currentConfig) {
        // Attempt to initialize with a default config if possible
        const baseDirArg = process.argv.find(arg => arg.startsWith('--base-dir='));
        if (baseDirArg) {
          const projectPath = baseDirArg.split('=')[1];
          await initializeProject(projectPath);
        } else {
          return projectPathNotSetError;
        }
      }

      log('exclude_and_remove called with params: ' + JSON.stringify(params));
      log('Current file tree root: ' + fileTree?.path);

      // Use the excludeAndRemoveFile function
      await excludeAndRemoveFile(params.filepath, fileTree!, getProjectRoot());

      // Save the updated tree
      if (currentConfig) {
        await saveFileTree(currentConfig, fileTree!);
      }

      return createMcpResponse({
        message: `File or pattern excluded and removed: ${params.filepath}`
      });
    } catch (error) {
      log('Error in exclude_and_remove: ' + error);
      return createMcpResponse(`Failed to exclude and remove file or pattern: ` + error, true);
    }
  });

  server.tool("add_file_node", "Manually add a file to the file tree", {
    filepath: z.string().describe("The absolute path of the file to add to the tree")
  }, async (params: { filepath: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    try {
      log('add_file_node called with params: ' + JSON.stringify(params));
      
      // Check if file exists
      await fs.access(params.filepath);
      
      // Add the file node to the tree
      await addFileNode(params.filepath, fileTree!, getProjectRoot());
      
      // Save the updated tree
      if (currentConfig) {
        await saveFileTree(currentConfig, fileTree!);
      }
      
      return createMcpResponse({
        message: `File successfully added to tree: ${params.filepath}`
      });
    } catch (error) {
      log('Error in add_file_node: ' + error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createMcpResponse(`File not found: ${params.filepath}`, true);
      }
      return createMcpResponse(`Failed to add file node: ` + error, true);
    }
  });

  server.tool("remove_file_node", "Manually remove a file from the file tree", {
    filepath: z.string().describe("The path of the file to remove from the tree")
  }, async (params: { filepath: string }) => {
    if (!isProjectPathSet()) return projectPathNotSetError;
    try {
      log('remove_file_node called with params: ' + JSON.stringify(params));
      
      // Remove the file node from the tree
      await removeFileNode(params.filepath, fileTree!, getProjectRoot());
      
      // Save the updated tree
      if (currentConfig) {
        await saveFileTree(currentConfig, fileTree!);
      }
      
      return createMcpResponse({
        message: `File successfully removed from tree: ${params.filepath}`
      });
    } catch (error) {
      log('Error in remove_file_node: ' + error);
      return createMcpResponse(`Failed to remove file node: ` + error, true);
    }
  });

  log('MCP server instance created with tools registered');
  return server;
}

/**
 * Initialize server state (called once during startup)
 */
export async function initializeServerState(): Promise<void> {
  log('Initializing server state...');
  
  // Initialize global config
  try {
    const config = await loadConfig();
    setConfig(config);
    log('Configuration loaded successfully');
  } catch (error) {
    log('Failed to load configuration: ' + error);
  }

  // Check for base directory argument
  const baseDirArg = process.argv.find(arg => arg.startsWith('--base-dir='));
  if (baseDirArg) {
    const projectPath = baseDirArg.split('=')[1];
    log(`Base directory specified: ${projectPath}`);
    await initializeProject(projectPath);
  }

  log('Server state initialized');
}
