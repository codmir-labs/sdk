/**
 * Codebase Intelligence - Advanced Code Analysis and Understanding
 * 
 * Provides deep insights into codebases, understands code patterns,
 * identifies issues, suggests improvements, and tracks technical debt.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join, extname, basename } from 'path'

import type {
  autonomusConfig,
  Context,
  CodebaseSnapshot,
  CodeIssue,
  CodeChange
} from '../types'

/**
 * CodebaseIntelligence provides comprehensive code analysis and insights
 */
export class CodebaseIntelligence extends EventEmitter {
  private config: autonomusConfig
  private analysisCache = new Map<string, CodebaseAnalysis>()
  private patternDetector: CodePatternDetector
  private issueScanner: CodeIssueScanner
  private qualityAnalyzer: CodeQualityAnalyzer
  private architectureAnalyzer: ArchitectureAnalyzer

  // Metrics
  private metrics = {
    codebasesAnalyzed: 0,
    issuesDetected: 0,
    patternsDiscovered: 0,
    averageAnalysisTime: 0
  }

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.patternDetector = new CodePatternDetector()
    this.issueScanner = new CodeIssueScanner()
    this.qualityAnalyzer = new CodeQualityAnalyzer()
    this.architectureAnalyzer = new ArchitectureAnalyzer()
  }

  async initialize(): Promise<void> {
    console.log('💻 Initializing Codebase Intelligence...')

    await Promise.all([
      this.patternDetector.initialize(),
      this.issueScanner.initialize(),
      this.qualityAnalyzer.initialize(),
      this.architectureAnalyzer.initialize()
    ])

    console.log('✅ Codebase Intelligence ready')
  }

  /**
   * Get latest codebase insights
   */
  getInsights(): any {
    return Array.from(this.analysisCache.values()).pop() || null
  }

  /**
   * Analyze codebase for comprehensive insights
   */
  async analyzeCodebase(params: {
    projectPath: string
    includePatterns?: string[]
    excludePatterns?: string[]
    depth: 'shallow' | 'medium' | 'deep' | 'comprehensive'
  }): Promise<CodebaseAnalysis> {
    const startTime = Date.now()
    const cacheKey = `${params.projectPath}_${params.depth}`

    try {
      // Check cache first
      if (this.analysisCache.has(cacheKey)) {
        const cached = this.analysisCache.get(cacheKey)!
        // Return cached if less than 1 hour old
        if (Date.now() - new Date(cached.analyzedAt).getTime() < 3600000) {
          return cached
        }
      }

      console.log(`🔍 Analyzing codebase: ${basename(params.projectPath)} (${params.depth})`)

      // Scan codebase structure
      const fileStructure = await this.scanFileStructure(params.projectPath, {
        include: params.includePatterns || ['**/*.{js,ts,jsx,tsx,py,java,cpp,h,css,html}'],
        exclude: params.excludePatterns || ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
      })

      // Multi-layer analysis based on depth
      const analysis: CodebaseAnalysis = {
        id: randomUUID(),
        projectPath: params.projectPath,

        // Basic Structure
        fileStructure,
        codeMetrics: await this.calculateCodeMetrics(fileStructure),
        languageDistribution: this.analyzeLanguageDistribution(fileStructure),

        // Quality Analysis
        issues: await this.scanForIssues(fileStructure, params.depth),
        codeQuality: await this.analyzeCodeQuality(fileStructure, params.depth),
        techDebt: await this.analyzeTechnicalDebt(fileStructure, params.depth),

        // Architecture and Patterns
        architecture: await this.analyzeArchitecture(fileStructure, params.depth),
        patterns: await this.detectPatterns(fileStructure, params.depth),
        dependencies: await this.analyzeDependencies(params.projectPath, params.depth),

        // Security and Performance
        security: await this.analyzeSecurityIssues(fileStructure, params.depth),
        performance: await this.analyzePerformanceIssues(fileStructure, params.depth),

        // Insights and Recommendations
        insights: [],
        recommendations: [],
        hotspots: [],

        // Metadata
        analyzedAt: new Date().toISOString(),
        analysisDepth: params.depth,
        processingTime: 0,
        confidence: 0
      }

      // Generate insights and recommendations
      analysis.insights = await this.generateInsights(analysis)
      analysis.recommendations = await this.generateRecommendations(analysis)
      analysis.hotspots = this.identifyHotspots(analysis)
      analysis.confidence = this.calculateAnalysisConfidence(analysis)
      analysis.processingTime = Date.now() - startTime

      // Cache analysis
      this.analysisCache.set(cacheKey, analysis)
      this.limitCacheSize()

      // Update metrics
      this.metrics.codebasesAnalyzed++
      this.metrics.issuesDetected += analysis.issues.length
      this.metrics.patternsDiscovered += analysis.patterns.length
      this.metrics.averageAnalysisTime = (this.metrics.averageAnalysisTime + analysis.processingTime) / this.metrics.codebasesAnalyzed

      this.emit('codebase_analyzed', { analysis, processingTime: analysis.processingTime })

      return analysis

    } catch (error) {
      console.error('❌ Codebase analysis failed:', error)
      throw error
    }
  }

  /**
   * Analyze specific files for detailed insights
   */
  async analyzeFile(filePath: string): Promise<FileAnalysis> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const extension = extname(filePath).toLowerCase()

      const analysis: FileAnalysis = {
        filePath,
        extension,
        language: this.detectLanguage(extension),

        // Basic metrics
        lineCount: content.split('\n').length,
        codeLines: this.countCodeLines(content, extension),
        commentLines: this.countCommentLines(content, extension),
        blankLines: this.countBlankLines(content),

        // Complexity analysis
        complexity: await this.calculateFileComplexity(content, extension),
        maintainabilityIndex: this.calculateMaintainabilityIndex(content, extension),

        // Issues and patterns
        issues: await this.scanFileForIssues(content, filePath, extension),
        patterns: await this.detectFilePatterns(content, extension),

        // Dependencies
        imports: this.extractImports(content, extension),
        exports: this.extractExports(content, extension),

        // Quality metrics
        testCoverage: await this.estimateTestCoverage(filePath),
        documentation: this.analyzeDocumentation(content, extension),

        analyzedAt: new Date().toISOString()
      }

      return analysis
    } catch (error) {
      console.error(`❌ File analysis failed for ${filePath}:`, error)
      throw error
    }
  }

  /**
   * Get codebase health score
   */
  getHealthScore(analysis: CodebaseAnalysis): CodebaseHealthScore {
    const weights = {
      issues: 0.3,
      quality: 0.25,
      architecture: 0.2,
      security: 0.15,
      performance: 0.1
    }

    // Calculate component scores (0-100)
    const issueScore = Math.max(0, 100 - (analysis.issues.filter(i => i.severity === 'critical').length * 20) - (analysis.issues.filter(i => i.severity === 'high').length * 10))
    const qualityScore = analysis.codeQuality.overallScore * 100
    const architectureScore = analysis.architecture.quality * 100
    const securityScore = Math.max(0, 100 - (analysis.security.criticalIssues * 25) - (analysis.security.highIssues * 10))
    const performanceScore = Math.max(0, 100 - (analysis.performance.criticalIssues * 20) - (analysis.performance.warnings * 5))

    const overallScore =
      (issueScore * weights.issues) +
      (qualityScore * weights.quality) +
      (architectureScore * weights.architecture) +
      (securityScore * weights.security) +
      (performanceScore * weights.performance)

    return {
      overallScore: Math.round(overallScore),
      componentScores: {
        issues: Math.round(issueScore),
        quality: Math.round(qualityScore),
        architecture: Math.round(architectureScore),
        security: Math.round(securityScore),
        performance: Math.round(performanceScore)
      },
      grade: this.calculateGrade(overallScore),
      trend: 'stable', // Would track over time in real implementation
      recommendations: this.generateHealthRecommendations(overallScore, {
        issues: issueScore,
        quality: qualityScore,
        architecture: architectureScore,
        security: securityScore,
        performance: performanceScore
      })
    }
  }

  /**
   * Suggest code improvements
   */
  async suggestImprovements(analysis: CodebaseAnalysis): Promise<CodeImprovement[]> {
    const improvements: CodeImprovement[] = []

    // Issue-based improvements
    for (const issue of analysis.issues.filter(i => i.severity === 'critical' || i.severity === 'high')) {
      if (issue.suggestion) {
        improvements.push({
          type: 'issue_fix',
          priority: issue.severity === 'critical' ? 'high' : 'medium',
          description: `Fix ${issue.type}: ${issue.description}`,
          file: issue.file,
          line: issue.line,
          suggestion: issue.suggestion,
          effort: this.estimateEffort(issue.type),
          impact: this.estimateImpact(issue.type, issue.severity)
        })
      }
    }

    // Architecture improvements
    if (analysis.architecture.antiPatterns.length > 0) {
      improvements.push({
        type: 'architecture',
        priority: 'medium',
        description: 'Refactor architecture anti-patterns',
        suggestion: `Address ${analysis.architecture.antiPatterns.join(', ')}`,
        effort: 'high',
        impact: 'high'
      })
    }

    // Performance improvements
    if (analysis.performance.criticalIssues > 0) {
      improvements.push({
        type: 'performance',
        priority: 'high',
        description: 'Address critical performance issues',
        suggestion: 'Optimize database queries, reduce algorithmic complexity, implement caching',
        effort: 'medium',
        impact: 'high'
      })
    }

    // Security improvements
    if (analysis.security.criticalIssues > 0) {
      improvements.push({
        type: 'security',
        priority: 'critical',
        description: 'Fix security vulnerabilities',
        suggestion: 'Address input validation, authentication, and authorization issues',
        effort: 'medium',
        impact: 'critical'
      })
    }

    return improvements.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 }
      return priorityOrder[b.priority] - priorityOrder[a.priority]
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Analysis Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async scanFileStructure(projectPath: string, options: {
    include: string[]
    exclude: string[]
  }): Promise<FileStructure> {
    const files: CodeFile[] = []

    try {
      // In a real implementation, this would use a proper file scanner like glob
      // For now, we'll simulate the structure
      const mockFiles = [
        { path: 'src/components/App.tsx', size: 2048, lastModified: new Date().toISOString() },
        { path: 'src/utils/helpers.ts', size: 1024, lastModified: new Date().toISOString() },
        { path: 'src/services/api.ts', size: 3072, lastModified: new Date().toISOString() },
        { path: 'tests/app.test.ts', size: 1536, lastModified: new Date().toISOString() },
        { path: 'package.json', size: 512, lastModified: new Date().toISOString() }
      ]

      for (const mockFile of mockFiles) {
        files.push({
          path: mockFile.path,
          absolutePath: join(projectPath, mockFile.path),
          relativePath: mockFile.path,
          size: mockFile.size,
          extension: extname(mockFile.path),
          language: this.detectLanguage(extname(mockFile.path)),
          lastModified: mockFile.lastModified
        })
      }

      return {
        totalFiles: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
        files,
        directories: this.extractDirectories(files),
        extensions: this.countExtensions(files)
      }
    } catch (error) {
      console.error('Failed to scan file structure:', error)
      return {
        totalFiles: 0,
        totalSize: 0,
        files: [],
        directories: [],
        extensions: {}
      }
    }
  }

  private async calculateCodeMetrics(fileStructure: FileStructure): Promise<CodeMetrics> {
    let totalLines = 0
    let codeLines = 0
    let commentLines = 0
    let blankLines = 0

    // Simulate code metrics calculation
    for (const file of fileStructure.files) {
      const estimatedLines = Math.floor(file.size / 25) // Rough estimate
      totalLines += estimatedLines
      codeLines += Math.floor(estimatedLines * 0.7) // 70% code
      commentLines += Math.floor(estimatedLines * 0.15) // 15% comments
      blankLines += Math.floor(estimatedLines * 0.15) // 15% blank
    }

    return {
      totalLines,
      codeLines,
      commentLines,
      blankLines,
      averageFileSize: fileStructure.totalSize / fileStructure.totalFiles,
      codeToCommentRatio: commentLines > 0 ? codeLines / commentLines : codeLines,
      complexity: this.calculateOverallComplexity(fileStructure)
    }
  }

  private analyzeLanguageDistribution(fileStructure: FileStructure): LanguageDistribution {
    const distribution: Record<string, number> = {}

    for (const file of fileStructure.files) {
      const lang = file.language || 'unknown'
      distribution[lang] = (distribution[lang] || 0) + file.size
    }

    const total = Object.values(distribution).reduce((sum, size) => sum + size, 0)
    const percentages: Record<string, number> = {}

    for (const [lang, size] of Object.entries(distribution)) {
      percentages[lang] = (size / total) * 100
    }

    return {
      languages: distribution,
      percentages,
      primaryLanguage: Object.entries(distribution).sort(([, a], [, b]) => b - a)[0]?.[0] || 'unknown',
      languageCount: Object.keys(distribution).length
    }
  }

  private async scanForIssues(fileStructure: FileStructure, depth: string): Promise<CodeIssue[]> {
    return this.issueScanner.scanFiles(fileStructure.files, depth)
  }

  private async analyzeCodeQuality(fileStructure: FileStructure, depth: string): Promise<CodeQuality> {
    return this.qualityAnalyzer.analyze(fileStructure, depth)
  }

  private async analyzeTechnicalDebt(fileStructure: FileStructure, depth: string): Promise<TechnicalDebt> {
    // Simulate technical debt analysis
    const debtItems = []

    // Look for indicators of technical debt
    if (fileStructure.files.some(f => f.path.includes('legacy'))) {
      debtItems.push({
        type: 'legacy_code',
        description: 'Legacy code files require refactoring',
        severity: 'medium',
        estimatedEffort: '2-3 days',
        impact: 'maintainability'
      })
    }

    if (fileStructure.files.filter(f => f.path.includes('test')).length < fileStructure.files.length * 0.3) {
      debtItems.push({
        type: 'missing_tests',
        description: 'Test coverage is below recommended threshold',
        severity: 'high',
        estimatedEffort: '1-2 weeks',
        impact: 'reliability'
      })
    }

    return {
      totalDebt: debtItems.length,
      debtItems,
      estimatedCost: debtItems.length * 2, // Days
      priorityItems: debtItems.filter(item => item.severity === 'high'),
      categories: {
        code_smells: debtItems.filter(item => item.type.includes('code')).length,
        missing_tests: debtItems.filter(item => item.type.includes('test')).length,
        documentation: debtItems.filter(item => item.type.includes('doc')).length,
        architecture: debtItems.filter(item => item.type.includes('architecture')).length
      }
    }
  }

  private async analyzeArchitecture(fileStructure: FileStructure, depth: string): Promise<ArchitectureAnalysis> {
    return this.architectureAnalyzer.analyze(fileStructure, depth)
  }

  private async detectPatterns(fileStructure: FileStructure, depth: string): Promise<CodePattern[]> {
    return this.patternDetector.detectPatterns(fileStructure, depth)
  }

  private async analyzeDependencies(projectPath: string, depth: string): Promise<DependencyAnalysis> {
    // Simulate dependency analysis
    const dependencies = [
      { name: 'react', version: '18.2.0', type: 'production', vulnerabilities: 0 },
      { name: 'typescript', version: '5.0.0', type: 'development', vulnerabilities: 0 },
      { name: 'lodash', version: '4.17.20', type: 'production', vulnerabilities: 1 },
      { name: '@types/node', version: '18.0.0', type: 'development', vulnerabilities: 0 }
    ]

    const outdated = dependencies.filter(dep => {
      // Simple heuristic for outdated packages
      const version = dep.version.split('.')[0]
      return parseInt(version) < 4 && dep.name !== '@types/node'
    })

    return {
      totalDependencies: dependencies.length,
      productionDependencies: dependencies.filter(d => d.type === 'production').length,
      developmentDependencies: dependencies.filter(d => d.type === 'development').length,
      vulnerabilities: dependencies.reduce((sum, d) => sum + d.vulnerabilities, 0),
      outdatedDependencies: outdated.length,
      dependencyTree: dependencies,
      circularDependencies: [],
      unusedDependencies: []
    }
  }

  private async analyzeSecurityIssues(fileStructure: FileStructure, depth: string): Promise<SecurityAnalysis> {
    // Simulate security analysis
    return {
      criticalIssues: 0,
      highIssues: 1,
      mediumIssues: 2,
      lowIssues: 3,
      issues: [
        {
          type: 'potential_xss',
          severity: 'high',
          file: 'src/components/App.tsx',
          line: 45,
          description: 'Potential XSS vulnerability in user input handling',
          recommendation: 'Sanitize user input before rendering'
        }
      ],
      securityScore: 85
    }
  }

  private async analyzePerformanceIssues(fileStructure: FileStructure, depth: string): Promise<PerformanceAnalysis> {
    // Simulate performance analysis
    return {
      criticalIssues: 0,
      warnings: 2,
      suggestions: 5,
      hotspots: ['src/services/api.ts', 'src/utils/helpers.ts'],
      performanceScore: 78
    }
  }

  private async generateInsights(analysis: CodebaseAnalysis): Promise<string[]> {
    const insights: string[] = []

    // Language insights
    if (analysis.languageDistribution.languageCount > 3) {
      insights.push(`Multi-language codebase with ${analysis.languageDistribution.languageCount} languages - consider consolidation`)
    }

    // Quality insights
    if (analysis.codeQuality.overallScore < 0.7) {
      insights.push('Code quality below recommended threshold - focus on refactoring and code standards')
    }

    // Architecture insights
    if (analysis.architecture.antiPatterns.length > 0) {
      insights.push(`Architecture anti-patterns detected: ${analysis.architecture.antiPatterns.join(', ')}`)
    }

    // Technical debt insights
    if (analysis.techDebt.totalDebt > 10) {
      insights.push('High technical debt detected - prioritize refactoring efforts')
    }

    return insights
  }

  private async generateRecommendations(analysis: CodebaseAnalysis): Promise<string[]> {
    const recommendations: string[] = []

    // Security recommendations
    if (analysis.security.criticalIssues > 0) {
      recommendations.push('Address critical security vulnerabilities immediately')
    }

    // Performance recommendations
    if (analysis.performance.criticalIssues > 0) {
      recommendations.push('Optimize critical performance bottlenecks')
    }

    // Quality recommendations
    if (analysis.codeQuality.testCoverage < 80) {
      recommendations.push('Increase test coverage to at least 80%')
    }

    // Architecture recommendations
    if (analysis.architecture.complexity > 8) {
      recommendations.push('Simplify complex architectural components')
    }

    return recommendations
  }

  private identifyHotspots(analysis: CodebaseAnalysis): string[] {
    const hotspots: string[] = []

    // Files with multiple issues
    const issuesByFile = new Map<string, number>()
    for (const issue of analysis.issues) {
      issuesByFile.set(issue.file, (issuesByFile.get(issue.file) || 0) + 1)
    }

    // Add files with 3+ issues as hotspots
    for (const [file, count] of issuesByFile.entries()) {
      if (count >= 3) {
        hotspots.push(file)
      }
    }

    // Add performance hotspots
    hotspots.push(...analysis.performance.hotspots)

    return [...new Set(hotspots)]
  }

  private calculateAnalysisConfidence(analysis: CodebaseAnalysis): number {
    // Base confidence on depth and completeness of analysis
    let confidence = 0.5

    if (analysis.fileStructure.totalFiles > 0) confidence += 0.2
    if (analysis.issues.length >= 0) confidence += 0.1
    if (analysis.patterns.length > 0) confidence += 0.1
    if (analysis.architecture.patterns.length > 0) confidence += 0.1

    return Math.min(1.0, confidence)
  }

  private detectLanguage(extension: string): string {
    const languageMap: Record<string, string> = {
      '': 'JavaScript',
      '.jsx': 'JavaScript',
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.py': 'Python',
      '.java': 'Java',
      '.cpp': 'C++',
      '.c': 'C',
      '.h': 'C/C++',
      '.css': 'CSS',
      '.html': 'HTML',
      '.json': 'JSON',
      '.md': 'Markdown'
    }

    return languageMap[extension.toLowerCase()] || 'Unknown'
  }

  private extractDirectories(files: CodeFile[]): string[] {
    const dirs = new Set<string>()

    for (const file of files) {
      const parts = file.relativePath.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (dir) dirs.add(dir)
      }
    }

    return Array.from(dirs).sort()
  }

  private countExtensions(files: CodeFile[]): Record<string, number> {
    const extensions: Record<string, number> = {}

    for (const file of files) {
      const ext = file.extension || 'none'
      extensions[ext] = (extensions[ext] || 0) + 1
    }

    return extensions
  }

  private calculateOverallComplexity(fileStructure: FileStructure): number {
    // Simple complexity estimation based on file count and size
    const fileComplexity = Math.min(10, fileStructure.totalFiles / 10)
    const sizeComplexity = Math.min(10, fileStructure.totalSize / 100000)
    return (fileComplexity + sizeComplexity) / 2
  }

  private countCodeLines(content: string, extension: string): number {
    const lines = content.split('\n')
    return lines.filter(line => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    }).length
  }

  private countCommentLines(content: string, extension: string): number {
    const lines = content.split('\n')
    return lines.filter(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
    }).length
  }

  private countBlankLines(content: string): number {
    return content.split('\n').filter(line => line.trim() === '').length
  }

  private async calculateFileComplexity(content: string, extension: string): Promise<number> {
    // Simple cyclomatic complexity estimation
    const complexityKeywords = ['if', 'else', 'while', 'for', 'switch', 'case', 'try', 'catch']
    let complexity = 1 // Base complexity

    for (const keyword of complexityKeywords) {
      const matches = content.match(new RegExp(`\\b${keyword}\\b`, 'g'))
      complexity += matches ? matches.length : 0
    }

    return complexity
  }

  private calculateMaintainabilityIndex(content: string, extension: string): number {
    // Simplified maintainability index
    const lines = content.split('\n').length
    const complexity = Math.min(20, content.split(/\b(if|else|while|for)\b/).length)

    // Higher is better, scale 0-100
    return Math.max(0, Math.min(100, 100 - (complexity * 2) - (lines / 100)))
  }

  private async scanFileForIssues(content: string, filePath: string, extension: string): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = []

    // Simple pattern-based issue detection
    if (content.includes('eval(')) {
      issues.push({
        type: 'security',
        severity: 'high',
        file: filePath,
        line: content.split('\n').findIndex(line => line.includes('eval(')) + 1,
        description: 'Use of eval() is dangerous and should be avoided',
        suggestion: 'Replace eval() with safer alternatives'
      })
    }

    if (content.includes('TODO') || content.includes('FIXME')) {
      issues.push({
        type: 'maintainability',
        severity: 'low',
        file: filePath,
        description: 'TODO/FIXME comments found',
        suggestion: 'Address TODO and FIXME items'
      })
    }

    return issues
  }

  private async detectFilePatterns(content: string, extension: string): Promise<CodePattern[]> {
    const patterns: CodePattern[] = []

    // Simple pattern detection
    if (content.includes('class ') && content.includes('extends')) {
      patterns.push({
        name: 'Inheritance',
        type: 'oop',
        confidence: 0.9,
        description: 'Uses class inheritance pattern'
      })
    }

    if (content.includes('interface ') || content.includes('type ')) {
      patterns.push({
        name: 'Type Definitions',
        type: 'typing',
        confidence: 0.95,
        description: 'Defines custom types or interfaces'
      })
    }

    return patterns
  }

  private extractImports(content: string, extension: string): string[] {
    const imports: string[] = []
    const importRegex = /import.*?from\s+['"`]([^'"`]+)['"`]/g
    let match

    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1])
    }

    return imports
  }

  private extractExports(content: string, extension: string): string[] {
    const exports: string[] = []
    const exportRegex = /export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g
    let match

    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1])
    }

    return exports
  }

  private async estimateTestCoverage(filePath: string): Promise<number> {
    // Mock test coverage estimation
    if (filePath.includes('test')) return 100
    if (filePath.includes('util')) return 60
    return Math.random() * 80 + 20 // 20-100%
  }

  private analyzeDocumentation(content: string, extension: string): number {
    const lines = content.split('\n')
    const commentLines = lines.filter(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
    }).length

    return Math.min(1, commentLines / lines.length * 5) // 20% comments = 100% doc score
  }

  private calculateGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A'
    if (score >= 80) return 'B'
    if (score >= 70) return 'C'
    if (score >= 60) return 'D'
    return 'F'
  }

  private generateHealthRecommendations(overallScore: number, componentScores: any): string[] {
    const recommendations: string[] = []

    if (componentScores.security < 80) {
      recommendations.push('Address security vulnerabilities')
    }

    if (componentScores.performance < 70) {
      recommendations.push('Optimize performance bottlenecks')
    }

    if (componentScores.quality < 75) {
      recommendations.push('Improve code quality through refactoring')
    }

    return recommendations
  }

  private estimateEffort(issueType: string): 'low' | 'medium' | 'high' {
    const effortMap: Record<string, 'low' | 'medium' | 'high'> = {
      security: 'medium',
      performance: 'medium',
      maintainability: 'low',
      bug: 'medium',
      style: 'low'
    }

    return effortMap[issueType] || 'medium'
  }

  private estimateImpact(issueType: string, severity: string): 'low' | 'medium' | 'high' | 'critical' {
    if (severity === 'critical') return 'critical'
    if (severity === 'high') return 'high'
    if (issueType === 'security') return 'high'
    if (issueType === 'performance') return 'medium'
    return 'low'
  }

  private limitCacheSize(): void {
    if (this.analysisCache.size > 10) {
      const keys = Array.from(this.analysisCache.keys())
      const keysToDelete = keys.slice(0, 5)
      keysToDelete.forEach(key => this.analysisCache.delete(key))
    }
  }

  getMetrics() {
    return { ...this.metrics }
  }

  getCachedAnalyses(): CodebaseAnalysis[] {
    return Array.from(this.analysisCache.values())
  }
}

// Supporting Classes
class CodePatternDetector {
  async initialize(): Promise<void> {
    console.log('  🔍 Pattern detector ready')
  }

  async detectPatterns(fileStructure: FileStructure, depth: string): Promise<CodePattern[]> {
    const patterns: CodePattern[] = []

    // Detect common patterns based on file structure
    if (fileStructure.files.some(f => f.path.includes('component'))) {
      patterns.push({
        name: 'Component Architecture',
        type: 'architecture',
        confidence: 0.8,
        description: 'Uses component-based architecture pattern'
      })
    }

    if (fileStructure.files.some(f => f.path.includes('service'))) {
      patterns.push({
        name: 'Service Layer',
        type: 'architecture',
        confidence: 0.9,
        description: 'Implements service layer pattern'
      })
    }

    return patterns
  }
}

class CodeIssueScanner {
  async initialize(): Promise<void> {
    console.log('  🐛 Issue scanner ready')
  }

  async scanFiles(files: CodeFile[], depth: string): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = []

    // Simulate issue detection
    if (files.length > 100) {
      issues.push({
        type: 'complexity',
        severity: 'medium',
        file: 'project',
        description: 'Large codebase may benefit from modularization',
        suggestion: 'Consider breaking into smaller modules'
      })
    }

    return issues
  }
}

class CodeQualityAnalyzer {
  async initialize(): Promise<void> {
    console.log('  ✨ Quality analyzer ready')
  }

  async analyze(fileStructure: FileStructure, depth: string): Promise<CodeQuality> {
    // Simulate quality analysis
    return {
      overallScore: 0.85,
      maintainabilityScore: 0.82,
      readabilityScore: 0.88,
      testCoverage: 75,
      codeComplexity: 6.5,
      codeSmells: 5,
      duplication: 3.2
    }
  }
}

class ArchitectureAnalyzer {
  async initialize(): Promise<void> {
    console.log('  🏗️  Architecture analyzer ready')
  }

  async analyze(fileStructure: FileStructure, depth: string): Promise<ArchitectureAnalysis> {
    return {
      patterns: ['MVC', 'Service Layer'],
      antiPatterns: [],
      complexity: 6,
      quality: 0.8,
      modularity: 0.75,
      coupling: 'medium',
      cohesion: 'high'
    }
  }
}

// Supporting Interfaces
interface CodebaseAnalysis {
  id: string
  projectPath: string
  fileStructure: FileStructure
  codeMetrics: CodeMetrics
  languageDistribution: LanguageDistribution
  issues: CodeIssue[]
  codeQuality: CodeQuality
  techDebt: TechnicalDebt
  architecture: ArchitectureAnalysis
  patterns: CodePattern[]
  dependencies: DependencyAnalysis
  security: SecurityAnalysis
  performance: PerformanceAnalysis
  insights: string[]
  recommendations: string[]
  hotspots: string[]
  analyzedAt: string
  analysisDepth: string
  processingTime: number
  confidence: number
}

interface FileStructure {
  totalFiles: number
  totalSize: number
  files: CodeFile[]
  directories: string[]
  extensions: Record<string, number>
}

interface CodeFile {
  path: string
  absolutePath: string
  relativePath: string
  size: number
  extension: string
  language?: string
  lastModified: string
}

interface CodeMetrics {
  totalLines: number
  codeLines: number
  commentLines: number
  blankLines: number
  averageFileSize: number
  codeToCommentRatio: number
  complexity: number
}

interface LanguageDistribution {
  languages: Record<string, number>
  percentages: Record<string, number>
  primaryLanguage: string
  languageCount: number
}

interface CodeQuality {
  overallScore: number
  maintainabilityScore: number
  readabilityScore: number
  testCoverage: number
  codeComplexity: number
  codeSmells: number
  duplication: number
}

interface TechnicalDebt {
  totalDebt: number
  debtItems: any[]
  estimatedCost: number
  priorityItems: any[]
  categories: Record<string, number>
}

interface ArchitectureAnalysis {
  patterns: string[]
  antiPatterns: string[]
  complexity: number
  quality: number
  modularity: number
  coupling: string
  cohesion: string
}

interface CodePattern {
  name: string
  type: string
  confidence: number
  description: string
}

interface DependencyAnalysis {
  totalDependencies: number
  productionDependencies: number
  developmentDependencies: number
  vulnerabilities: number
  outdatedDependencies: number
  dependencyTree: any[]
  circularDependencies: any[]
  unusedDependencies: any[]
}

interface SecurityAnalysis {
  criticalIssues: number
  highIssues: number
  mediumIssues: number
  lowIssues: number
  issues: any[]
  securityScore: number
}

interface PerformanceAnalysis {
  criticalIssues: number
  warnings: number
  suggestions: number
  hotspots: string[]
  performanceScore: number
}

interface FileAnalysis {
  filePath: string
  extension: string
  language: string
  lineCount: number
  codeLines: number
  commentLines: number
  blankLines: number
  complexity: number
  maintainabilityIndex: number
  issues: CodeIssue[]
  patterns: CodePattern[]
  imports: string[]
  exports: string[]
  testCoverage: number
  documentation: number
  analyzedAt: string
}

interface CodebaseHealthScore {
  overallScore: number
  componentScores: {
    issues: number
    quality: number
    architecture: number
    security: number
    performance: number
  }
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  trend: 'improving' | 'declining' | 'stable'
  recommendations: string[]
}

interface CodeImprovement {
  type: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  description: string
  file?: string
  line?: number
  suggestion: string
  effort: 'low' | 'medium' | 'high'
  impact: 'low' | 'medium' | 'high' | 'critical'
}
