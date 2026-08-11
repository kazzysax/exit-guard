// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title ExitGuardExecutor
/// @notice Pulls an approved ERC-20 position from a trading agent's wallet, swaps it to WETH
///         on Uniswap V3, retains a completion fee, and returns the remainder — atomically.
///         The agent's funds are never at rest inside this contract.
contract ExitGuardExecutor {
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 100; // 1% hard ceiling, immutable by design

    address public immutable router;
    address public immutable weth;

    address public admin;
    address public feeRecipient;

    /// @notice Addresses permitted to trigger exits. This is the KeeperHub org wallet.
    mapping(address => bool) public keepers;

    /// @notice Per-owner opt-in. An allowance alone is not authorisation.
    mapping(address => bool) public enrolled;

    uint256 private locked = 1;

    event ExitExecuted(
        address indexed owner,
        address indexed token,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 ownerAmount
    );
    event Enrolled(address indexed owner, bool status);
    event KeeperSet(address indexed keeper, bool status);
    event FeeRecipientSet(address indexed recipient);
    event AdminSet(address indexed admin);

    error NotAdmin();
    error NotKeeper();
    error NotEnrolled();
    error FeeTooHigh();
    error ZeroAmount();
    error Reentrant();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address _router, address _weth, address _feeRecipient) {
        if (_router == address(0) || _weth == address(0) || _feeRecipient == address(0)) {
            revert ZeroAddress();
        }
        router = _router;
        weth = _weth;
        admin = msg.sender;
        feeRecipient = _feeRecipient;
        keepers[msg.sender] = true;
        emit AdminSet(msg.sender);
        emit KeeperSet(msg.sender, true);
        emit FeeRecipientSet(_feeRecipient);
    }

    // --- Owner opt-in -------------------------------------------------------

    /// @notice A trading agent calls this once to authorise Exit Guard.
    ///         Revoking here disables exits even if an ERC-20 allowance is still outstanding.
    function setEnrolled(bool status) external {
        enrolled[msg.sender] = status;
        emit Enrolled(msg.sender, status);
    }

    // --- Execution ----------------------------------------------------------

    /// @notice Pull, swap, split, return. Reverts as a unit.
    /// @param owner       Wallet holding the position; must be enrolled and have approved this contract.
    /// @param token       ERC-20 being exited.
    /// @param poolFee     Uniswap V3 fee tier.
    /// @param amountIn    Amount to exit. Pass 0 to exit the full balance.
    /// @param amountOutMinimum Slippage floor, computed off-chain.
    /// @param feeBps      Completion fee in basis points, capped at MAX_FEE_BPS.
    function exit(
        address owner,
        address token,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint16 feeBps
    ) external onlyKeeper nonReentrant returns (uint256 ownerAmount) {
        if (!enrolled[owner]) revert NotEnrolled();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        if (amountIn == 0) {
            uint256 bal = IERC20(token).balanceOf(owner);
            uint256 allowed = IERC20(token).allowance(owner, address(this));
            amountIn = bal < allowed ? bal : allowed;
        }
        if (amountIn == 0) revert ZeroAmount();

        if (!IERC20(token).transferFrom(owner, address(this), amountIn)) revert TransferFailed();

        IERC20(token).approve(router, 0);
        IERC20(token).approve(router, amountIn);

        uint256 amountOut = ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: weth,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 feeAmount = (amountOut * feeBps) / BPS;
        ownerAmount = amountOut - feeAmount;

        if (feeAmount > 0) {
            if (!IERC20(weth).transfer(feeRecipient, feeAmount)) revert TransferFailed();
        }
        if (!IERC20(weth).transfer(owner, ownerAmount)) revert TransferFailed();

        emit ExitExecuted(owner, token, amountIn, amountOut, feeAmount, ownerAmount);
    }

    // --- Admin --------------------------------------------------------------

    function setKeeper(address keeper, bool status) external onlyAdmin {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = status;
        emit KeeperSet(keeper, status);
    }

    function setFeeRecipient(address recipient) external onlyAdmin {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
        emit AdminSet(newAdmin);
    }

    /// @notice Sweep tokens stranded by a failed leg. Nothing should ever rest here.
    function rescue(address token, address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
