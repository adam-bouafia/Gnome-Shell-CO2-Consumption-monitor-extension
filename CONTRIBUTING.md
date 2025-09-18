# Contributing to CO2 Consumption Monitor

Thank you for your interest in contributing to the CO2 Consumption Monitor GNOME Shell extension! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Contributing Guidelines](#contributing-guidelines)
- [Submitting Changes](#submitting-changes)
- [Testing](#testing)
- [Documentation](#documentation)
- [Community](#community)

## Code of Conduct

This project adheres to a code of conduct that ensures a welcoming environment for all contributors. By participating, you agree to:

- Be respectful and inclusive
- Focus on constructive feedback
- Help maintain a harassment-free environment
- Support newcomers and answer questions patiently

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- Linux system with GNOME Shell 43–45
- Git for version control
- Text editor or IDE of your choice
- Basic knowledge of JavaScript (GJS/ES Modules)

### Development Dependencies

Install additional development tools:

```bash
# Install development dependencies
pip3 install --user black flake8 pytest

# Install GNOME development tools
sudo apt install gjs libgjs-dev  # Ubuntu/Debian
sudo dnf install gjs-devel       # Fedora
sudo pacman -S gjs               # Arch Linux
```

## Development Setup

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/adam-bouafia/Gnome-Shell-CO2-Consumption-monitor-extension.git
cd co2-consumption-monitor

# Add upstream remote
git remote add upstream https://github.com/adam-bouafia/Gnome-Shell-CO2-Consumption-monitor-extension.git
```

### 2. Create Development Environment

```bash
# Create a development branch
git checkout -b feature/your-feature-name

# Install Python dependencies
pip3 install --user codecarbon psutil black flake8
sudo apt install gjs libgjs-dev  # Ubuntu/Debian
sudo dnf install gjs-devel       # Fedora
sudo pacman -S gjs               # Arch Linux
# Create symlink for testing
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -sf $(pwd) ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com
```

### 3. Test Your Setup

```bash
# Test Python script
python3 co2_monitor.py

# Test extension loading (requires GNOME Shell restart)
gnome-extensions enable co2consumption@gmail.com
```

## Contributing Guidelines

### Types of Contributions

We welcome various types of contributions:

- **Bug fixes**: Fix issues reported in GitHub Issues
```
- **Documentation**: Improve README, guides, or code comments
- **Translations**: Add support for new languages
- **Performance improvements**: Optimize code efficiency
- **Testing**: Add or improve test coverage

```

#### JavaScript (GJS)

- Follow the [GNOME JavaScript Style Guide](https://gjs.guide/guides/gjs/style-guide.html)
- Use 4-space indentation
- Use camelCase for variables and functions
- Use PascalCase for classes
 * @param {Object} data - CO2 data object
 * @param {number} data.total_co2_g - Total CO2 in grams
 */
_updateUI(data) {
    // Implementation here
- Follow [PEP 8](https://pep8.org/) style guide
- Use 4-space indentation
- Use snake_case for variables and functions
- Use PascalCase for classes
- Add docstrings for functions and classes
- Format code with `black`

Example:
```python
def calculate_per_software_co2(total_co2_g: float) -> List[Dict[str, Any]]:
    """
    Calculate CO2 consumption per software process.
    
    Args:
        total_co2_g: Total CO2 consumption in grams

#### Code Quality

Run these checks before submitting:

```bash
# Python code formatting and linting
black co2_monitor.py
flake8 co2_monitor.py

# JavaScript linting (if available)
eslint extension.js
```

### Commit Guidelines

Use clear, descriptive commit messages:

```bash
# Good commit messages
git commit -m "Fix: Handle codecarbon initialization errors gracefully"
git commit -m "Feature: Add configurable update intervals"
```
# Bad commit messages
git commit -m "Fix bug"
git commit -m "Update code"
git commit -m "Changes"
```

Commit message format:
- **Type**: `Fix`, `Feature`, `Docs`, `Refactor`, `Test`, `Style`
- **Description**: Clear, concise description of changes
- **Body** (optional): Additional details if needed

## Submitting Changes

### 1. Prepare Your Changes

```bash
# Ensure your branch is up to date
git fetch upstream
git rebase upstream/main

# Run tests and checks
python3 co2_monitor.py  # Test Python script
black co2_monitor.py    # Format Python code
flake8 co2_monitor.py   # Lint Python code
```

### 2. Create Pull Request

1. Push your branch to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
```
3. Fill out the PR template with:
   - **Description**: What changes you made and why
   - **Testing**: How you tested the changes
   - **Screenshots**: If UI changes are involved
   - **Breaking changes**: If any breaking changes exist

### 3. Review Process

- Maintainers will review your PR
- Address any feedback or requested changes
- Once approved, your PR will be merged

## Testing

### Manual Testing

1. **Basic functionality**:
   ```bash
   # Test Python script directly
   python3 co2_monitor.py
   
   # Test extension in GNOME Shell
    gnome-extensions enable co2consumption@gmail.com
   ```

2. **Error handling**:
   - Test with missing dependencies
   - Test with insufficient permissions
   - Test with high system load

3. **Performance testing**:
   - Monitor CPU usage during operation
   - Test with many running processes
   - Verify memory usage remains stable

### Automated Testing

Add tests for new functionality:

```python
# Example test structure
import unittest
from unittest.mock import patch, MagicMock

class TestCO2Monitor(unittest.TestCase):
    def test_calculate_per_software_co2(self):
        # Test implementation
        pass
    
    @patch('psutil.process_iter')
    def test_process_monitoring(self, mock_process_iter):
        # Test with mocked processes
        pass

if __name__ == '__main__':
    unittest.main()
```

### Integration Testing

Test the extension in different environments:

- Various GNOME Shell versions (3.36, 40, 42, 44, 45)
- Different Linux distributions
- Various Python versions (3.7, 3.8, 3.9, 3.10, 3.11)

## Documentation

### Code Documentation
- Update README.md for new features
- Update INSTALL.md for installation changes

### User Documentation

- Update help text in preferences
- Add examples for new features
- Create or update screenshots
- Write clear error messages

### Translation

To add translations:

1. Create locale files in `locale/` directory
2. Use standard gettext format
3. Test translations in different locales

## Community

### Getting Help

- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Ask questions or discuss ideas
- **GNOME Discourse**: General GNOME extension development

### Reporting Issues

When reporting bugs, include:

- **System information**: OS, GNOME Shell version, Python version
- **Steps to reproduce**: Clear steps to reproduce the issue
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Logs**: Relevant error messages or logs
- **Screenshots**: If applicable

### Feature Requests

For new features, provide:

- **Use case**: Why is this feature needed?
- **Description**: Detailed description of the feature
- **Mockups**: UI mockups if applicable
- **Implementation ideas**: Suggestions for implementation

## Release Process

### Versioning

We use [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Release Checklist

Before releasing:

- [ ] Update version in `metadata.json`
- [ ] Update CHANGELOG.md
- [ ] Test on multiple GNOME Shell versions
- [ ] Update documentation
- [ ] Create release notes
- [ ] Tag the release

## Recognition

Contributors are recognized in:

- **CONTRIBUTORS.md**: List of all contributors
- **Release notes**: Major contributions are highlighted
- **GitHub**: Contributor statistics and graphs

Thank you for contributing to making computing more environmentally conscious!

## Questions?

If you have questions about contributing, feel free to:

- Open a GitHub Discussion
- Comment on relevant issues
- Reach out to maintainers

We appreciate your interest in improving this project!

